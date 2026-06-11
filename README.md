A Spectacles lens built in Lens Studio.

## Cloning & setup

This project uses [Git LFS](https://git-lfs.com) for binary assets and packages.
Make sure it is installed before cloning:

```bash
git lfs install
git clone https://github.com/kaifengwu001/TriviaWorld.git
```

## RSG credentials (important)

The `RemoteServiceGatewayCredentials` component stores its API tokens (OpenAI,
Google, Snap) inline inside `Assets/Scene.scene`. To keep those tokens out of
git, the repo uses a **git clean filter** that replaces the token values with
placeholders in every commit — your local working copy keeps the real tokens so
the lens still runs.

The filter is declared in `.gitattributes`:

```
Assets/Scene.scene filter=rsgtokens
```

…but the filter itself is configured in `.git/config`, which is **not** part of
the repo. After cloning (or on any new machine), run these two commands **once**
so the filter is active:

```bash
git config filter.rsgtokens.clean ".gitfilters/scrub-rsg-tokens.sh"
git config filter.rsgtokens.smudge cat
```

> ⚠️ If you commit changes to `Assets/Scene.scene` **without** configuring the
> filter, your real tokens will be committed in plaintext. Always run the
> commands above first.

After cloning, the scene will contain placeholder tokens
(`[INSERT OPENAI TOKEN HERE]`, etc.). Open the project in Lens Studio, select the
`RemoteServiceGatewayCredentials` object, and paste your own tokens into the
inspector. They stay local and are scrubbed automatically on commit.
