/**
 * Specs Inc. 2026
 * Scene Switcher Panel for the Crop Spectacles lens.
 *
 * Drives three pre-authored, toggleable round buttons (Scene1/Scene2/Scene3 in
 * the scene). Each button owns a "group" of scene objects/prefabs: activating a
 * group enables every object in it and disables every object in the other two
 * groups. Exactly one group is active at a time (radio behaviour). The active
 * button is shown in its highlighted (toggled) visual state, its icon image is
 * driven to full opacity, and the inactive buttons' icons fade back.
 *
 * The whole panel continuously billboards in front of the camera: each frame it
 * eases (lerp/slerp) toward a point a configurable distance + height in front of
 * the head, but only once the head has drifted beyond a dead zone — so small
 * head movements don't make the panel jitter.
 *
 * Registered on `global.sceneSwitcher` so it can be driven across prefab
 * boundaries — today by the buttons, in future by a WebSocket message or the
 * VoiceAgent (e.g. global.sceneSwitcher.activateGroup(1) or
 * global.sceneSwitcher.activateGroupByName("Globe")). Mirrors the global-
 * singleton pattern used by cropInterestStore / cardVoiceAgent.
 */
import { Logger } from "Utilities.lspkg/Scripts/Utils/Logger";
import { RoundButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/RoundButton";

// A scene-switcher group: its label, button, icon texture/runtime image, and the
// objects it owns. `icon` is the Image component the script builds at runtime
// from `iconTexture`; its opacity is driven by selection.
type SceneGroup = {
  name: string;
  buttonObj: SceneObject | null;
  button: RoundButton | null;
  iconTexture: Texture | null;
  icon: Image | null;
  objects: SceneObject[];
};

@component
export class SceneSwitcherPanel extends BaseScriptComponent {
  @ui.label('<span style="color: #60A5FA;">SceneSwitcherPanel – three-way scene toggler</span><br/><span style="color: #94A3B8; font-size: 11px;">Wires three pre-made round toggle buttons. Pressing one enables its group of objects and disables the other two, drives icon opacity, and continuously billboards in front of the camera. Controllable from script via global.sceneSwitcher.activateGroup(i).</span>')
  @ui.separator

  @ui.label('<span style="color: #60A5FA;">Scene References</span>')
  @input
  @hint("Head camera object (wire the 'Camera Object'). The panel billboards in front of it.")
  cameraObj: SceneObject;

  // --- Group 1 ---
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Group 1</span>')
  @input
  @hint("The Scene1 round toggle button object")
  @allowUndefined
  scene1Button: SceneObject;

  @input
  @hint("Icon texture (PNG) shown on the Scene1 button. The script builds the image; its opacity is driven by selection.")
  @allowUndefined
  scene1IconTexture: Texture;

  @input
  @hint("Text shown under the Scene1 button")
  scene1Label: string = "Scene 1";

  @input
  @hint("Objects/prefabs enabled when Group 1 is active (disabled otherwise)")
  @allowUndefined
  scene1Objects: SceneObject[] = [];

  // --- Group 2 ---
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Group 2</span>')
  @input
  @hint("The Scene2 round toggle button object")
  @allowUndefined
  scene2Button: SceneObject;

  @input
  @hint("Icon texture (PNG) shown on the Scene2 button. The script builds the image; its opacity is driven by selection.")
  @allowUndefined
  scene2IconTexture: Texture;

  @input
  @hint("Text shown under the Scene2 button")
  scene2Label: string = "Scene 2";

  @input
  @hint("Objects/prefabs enabled when Group 2 is active (disabled otherwise)")
  @allowUndefined
  scene2Objects: SceneObject[] = [];

  // --- Group 3 ---
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Group 3</span>')
  @input
  @hint("The Scene3 round toggle button object")
  @allowUndefined
  scene3Button: SceneObject;

  @input
  @hint("Icon texture (PNG) shown on the Scene3 button. The script builds the image; its opacity is driven by selection.")
  @allowUndefined
  scene3IconTexture: Texture;

  @input
  @hint("Text shown under the Scene3 button")
  scene3Label: string = "Scene 3";

  @input
  @hint("Objects/prefabs enabled when Group 3 is active (disabled otherwise)")
  @allowUndefined
  scene3Objects: SceneObject[] = [];

  // --- Selection / appearance ---
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Selection & Icon Appearance</span>')
  @input
  @hint("Group selected on launch (1-3). 0 leaves all groups off until a button is pressed.")
  initialGroup: number = 1;

  @input
  @hint("Unlit, transparency-capable material the icons are drawn with. The script clones it per icon and sets the texture + opacity on the clone.")
  @allowUndefined
  iconMaterial: Material;

  @input
  @hint("Icon height in cm. Width follows the texture's aspect ratio.")
  iconSize: number = 2.0;

  @input
  @hint("How far in front of the button face (cm) the icon sits, to avoid clipping")
  iconForwardOffset: number = 0.2;

  @input
  @hint("Icon opacity (0-1) of the SELECTED scene's button")
  selectedIconAlpha: number = 1.0;

  @input
  @hint("Icon opacity (0-1) of UNSELECTED scenes' buttons")
  unselectedIconAlpha: number = 0.35;

  @input
  @hint("How far below each button (cm) the text label sits")
  labelOffset: number = 2.5;

  @input
  @hint("How far in front of the button face (cm) the label sits, to avoid clipping")
  labelForwardOffset: number = 0.2;

  @input
  @hint("Font size for the button labels")
  labelSize: number = 28;

  // --- Camera tracking ---
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Camera Tracking</span>')
  @input
  @hint("Continuously billboard-follow the camera. Turn off to keep the panel where it is authored.")
  enableTracking: boolean = true;

  @input
  @hint("Distance in cm to keep the panel in front of the camera")
  distanceFromCamera: number = 60;

  @input
  @hint("Vertical offset in cm from the camera's eye line (positive = higher)")
  heightOffset: number = 0;

  @input
  @hint("Position follow speed (lerp factor = followSpeed * dt). Lower = lazier, laggier follow.")
  followSpeed: number = 6;

  @input
  @hint("Rotation follow speed for the billboard (slerp factor = rotateSpeed * dt).")
  rotateSpeed: number = 6;

  @input
  @hint("Dead zone radius in cm: the panel only chases the camera once the target drifts beyond this, killing micro-jitter.")
  positionDeadzone: number = 5;

  // --- Logging ---
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Logging</span>')
  @input
  @hint("Enable general logging")
  enableLogging: boolean = false;

  @input
  @hint("Enable lifecycle logging (onAwake, onStart, onUpdate, onDestroy)")
  enableLoggingLifecycle: boolean = false;

  private logger: Logger;
  private groups: SceneGroup[] = [];
  private activeIndex: number = -1;
  private built: boolean = false;
  // Selection requested (e.g. by script/AI) before the panel finished building.
  private pendingIndex: number | null = null;

  private camTrans: Transform | null = null;
  // Smoothed pose, seeded (snapped) on the first update.
  private currentPos: vec3 | null = null;
  private currentRot: quat | null = null;

  onAwake() {
    this.logger = new Logger("SceneSwitcherPanel", this.enableLogging || this.enableLoggingLifecycle, true);
    if (this.enableLoggingLifecycle) this.logger.debug("LIFECYCLE: onAwake()");

    // Snapshot the inspector inputs into immutable group records. Filtering null
    // objects here keeps the rest of the code free of repeated null checks.
    this.groups = [
      this.makeGroup(this.scene1Label, this.scene1Button, this.scene1IconTexture, this.scene1Objects),
      this.makeGroup(this.scene2Label, this.scene2Button, this.scene2IconTexture, this.scene2Objects),
      this.makeGroup(this.scene3Label, this.scene3Button, this.scene3IconTexture, this.scene3Objects),
    ];

    // Future WebSocket / VoiceAgent control reaches the switcher through this
    // global (same pattern as cropInterestStore / cardVoiceAgent).
    (global as any).sceneSwitcher = this;

    // Build after OnStart so the scene + UI Kit buttons are ready.
    this.createEvent("OnStartEvent").bind(() => this.setup());
  }

  private makeGroup(label: string, buttonObj: SceneObject, iconTexture: Texture, objects: SceneObject[]): SceneGroup {
    const cleaned = (objects ?? []).filter((obj) => obj !== null && obj !== undefined);
    const name = label && label.trim().length > 0 ? label.trim() : "Scene";
    return {
      name,
      buttonObj: buttonObj ?? null,
      button: null,
      iconTexture: iconTexture ?? null,
      icon: null,
      objects: cleaned,
    };
  }

  private setup() {
    if (this.cameraObj) {
      this.camTrans = this.cameraObj.getTransform();
    } else {
      this.logger.error("cameraObj not assigned — wire the head Camera Object. Tracking disabled.");
    }

    this.groups.forEach((group, index) => this.wireGroup(group, index));

    this.built = true;

    // Apply the launch selection (or a selection that arrived early via script).
    const startIndex = this.pendingIndex !== null ? this.pendingIndex : this.initialGroup - 1;
    this.pendingIndex = null;
    this.applySelection(startIndex);

    this.createEvent("UpdateEvent").bind(() => this.update(getDeltaTime()));
    this.logger.info("Scene switcher ready with " + this.groups.length + " groups.");
  }

  private wireGroup(group: SceneGroup, index: number) {
    if (!group.buttonObj) {
      this.logger.error('Group "' + group.name + '" has no button assigned.');
      return;
    }
    const button = group.buttonObj.getComponent(RoundButton.getTypeName()) as unknown as RoundButton;
    if (!button) {
      this.logger.error('Group "' + group.name + '" button has no RoundButton component.');
      return;
    }
    group.button = button;

    // Ensure the button is a toggle (for the highlighted visual) and initialized.
    // Both calls are idempotent, so this is safe even if the button already set
    // itself up on its own OnStart.
    button.setIsToggleable(true);
    button.initialize();

    // onTriggerUp fires on release; we authoritatively re-assert the whole radio
    // state in applySelection, so the toggle visual stays consistent even when
    // the user taps the already-active button.
    button.onTriggerUp.add(() => this.activateGroup(index));

    this.createIcon(group);
    this.createLabel(group);
  }

  /**
   * Builds the icon Image on a child of the button from the group's texture. The
   * shared icon material is CLONED per icon so each button's opacity (driven via
   * the clone's baseColor alpha) stays independent. The quad is scaled to the
   * texture's aspect ratio with `iconSize` as its height.
   */
  private createIcon(group: SceneGroup) {
    if (!group.buttonObj || !group.iconTexture) return;
    if (!this.iconMaterial) {
      this.logger.error("iconMaterial not assigned — cannot build icons. Assign an Unlit transparent material.");
      return;
    }

    const iconObj = global.scene.createSceneObject(group.name + " Icon");
    iconObj.setParent(group.buttonObj);
    // Sit just in front of the button face so the icon isn't hidden by the button.
    iconObj.getTransform().setLocalPosition(new vec3(0, 0, this.iconForwardOffset));

    const aspect = this.textureAspect(group.iconTexture);
    iconObj.getTransform().setLocalScale(new vec3(this.iconSize * aspect, this.iconSize, 1));

    const image = iconObj.createComponent("Component.Image") as Image;
    // Clone the shared material so per-icon texture + alpha don't bleed across icons.
    const mat = this.iconMaterial.clone();
    image.clearMaterials();
    image.addMaterial(mat);
    image.mainPass.baseTex = group.iconTexture;

    group.icon = image;
  }

  private textureAspect(tex: Texture): number {
    if (!tex) return 1;
    const w = tex.getWidth();
    const h = tex.getHeight();
    return w > 0 && h > 0 ? w / h : 1;
  }

  private createLabel(group: SceneGroup) {
    if (!group.buttonObj) return;
    const textObj = global.scene.createSceneObject(group.name + " Label");
    textObj.setParent(group.buttonObj);
    // Sit below the button face and slightly toward the viewer so it renders clear.
    textObj.getTransform().setLocalPosition(new vec3(0, -this.labelOffset, this.labelForwardOffset));
    const text = textObj.createComponent("Component.Text") as Text;
    text.text = group.name;
    text.size = Math.round(this.labelSize);
    text.horizontalAlignment = HorizontalAlignment.Center;
    text.verticalAlignment = VerticalAlignment.Center;
    text.textFill.color = new vec4(1, 1, 1, 1);
  }

  // --- Public control surface (buttons today; WebSocket / VoiceAgent tomorrow) ---

  /**
   * Activates the group at `index` (0-based): enables its objects, disables the
   * other groups, highlights the matching button and drives its icon to full
   * opacity. Out-of-range indices clear the selection (all groups off). Safe to
   * call before setup — the request is queued and applied once buttons exist.
   */
  activateGroup(index: number) {
    if (!this.built) {
      this.pendingIndex = index;
      this.logger.debug("activateGroup(" + index + ") queued until panel is built.");
      return;
    }
    this.applySelection(index);
  }

  /**
   * Activates the first group whose label matches `name` (case-insensitive).
   * Convenience for natural-language / agent-driven control.
   */
  activateGroupByName(name: string) {
    if (typeof name !== "string" || name.trim().length === 0) {
      this.logger.error("activateGroupByName called with an empty name.");
      return;
    }
    const target = name.trim().toLowerCase();
    const index = this.groups.findIndex((g) => g.name.toLowerCase() === target);
    if (index < 0) {
      this.logger.error('No group named "' + name + '".');
      return;
    }
    this.activateGroup(index);
  }

  /** 0-based index of the active group, or -1 when none is active. */
  getActiveIndex(): number {
    return this.activeIndex;
  }

  /** Labels of the configured groups, in order. */
  getGroupNames(): string[] {
    return this.groups.map((g) => g.name);
  }

  private applySelection(index: number) {
    this.activeIndex = index;
    this.groups.forEach((group, i) => {
      const isActive = i === index;
      this.setGroupEnabled(group, isActive);
      if (group.button) {
        group.button.toggle(isActive);
      }
      this.setIconAlpha(group, isActive ? this.selectedIconAlpha : this.unselectedIconAlpha);
    });

    const activeName = index >= 0 && index < this.groups.length ? this.groups[index].name : "(none)";
    this.logger.info("Active group: " + activeName);
  }

  private setGroupEnabled(group: SceneGroup, enabled: boolean) {
    group.objects.forEach((obj) => {
      obj.enabled = enabled;
    });
  }

  private setIconAlpha(group: SceneGroup, alpha: number) {
    const icon = group.icon;
    if (!icon || !icon.mainPass) return;
    const clamped = Math.max(0, Math.min(1, alpha));
    // Keep the texture's own colours; scale only opacity via the white tint's alpha.
    icon.mainPass.baseColor = new vec4(1, 1, 1, clamped);
  }

  private update(dt: number) {
    if (!this.enableTracking || !this.camTrans) return;

    const desired = this.computeDesiredPosition();
    // Content faces the user when its forward matches the camera's forward
    // (the established billboard convention in this project, see CardDeckController).
    const targetRot = quat.lookAt(this.camTrans.forward, vec3.up());
    const panelTrans = this.getSceneObject().getTransform();

    if (this.currentPos === null || this.currentRot === null) {
      // Snap into place on the first frame.
      this.currentPos = desired;
      this.currentRot = targetRot;
    } else {
      // Dead zone: only chase the camera once the target drifts beyond the slack
      // ball, then ease toward its edge so small head moves don't cause jitter.
      const toDesired = desired.sub(this.currentPos);
      const dist = toDesired.length;
      if (dist > this.positionDeadzone) {
        const edge = desired.sub(toDesired.normalize().uniformScale(this.positionDeadzone));
        this.currentPos = vec3.lerp(this.currentPos, edge, Math.min(1, this.followSpeed * dt));
      }
      this.currentRot = quat.slerp(this.currentRot, targetRot, Math.min(1, this.rotateSpeed * dt));
    }

    panelTrans.setWorldPosition(this.currentPos);
    panelTrans.setWorldRotation(this.currentRot);
  }

  private computeDesiredPosition(): vec3 {
    const camPos = this.camTrans.getWorldPosition();
    // In Lens Studio transform.forward points BEHIND the camera, so the view
    // direction is -forward (matches AgentSphere / TopicSelectionPanel).
    const viewDir = this.camTrans.forward.uniformScale(-1);
    return camPos
      .add(viewDir.uniformScale(this.distanceFromCamera))
      .add(vec3.up().uniformScale(this.heightOffset));
  }
}
