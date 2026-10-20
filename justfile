build:
    pnpm build

test:
    pnpm test

patch: build
    npm version patch --no-git-tag-version

minor: build
    npm version minor --no-git-tag-version

publish: build
    pnpm publish --access public

release-patch:
    just patch
    just publish

release-minor:
    just minor
    just publish
