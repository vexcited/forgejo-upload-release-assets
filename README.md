A Forgejo action that uploads files to the release of a tag. It creates the release when it does not exist yet, and replaces files that were already attached under the same name, so a rerun of the same job never fails on duplicates.

## Usage

```yaml
name: Release

on:
  push:
    tags:
      - "*"

jobs:
  release:
    runs-on: ubuntu-amd64

    steps:
      - uses: actions/checkout@v7

      - run: |
          mkdir release
          echo 'hi, everyone!' > release/hello.world
          sha256sum "release/hello.world.zip" > "release/hello.world.sha256"

      - uses: https://code.vexcited.com/forgejo/upload-release-assets@v1
        with:
          files: release/*
```

Also, several lines can be given at once.

```yaml
      - uses: https://code.vexcited.com/forgejo/upload-release-assets@v1
        with:
          files: |
            dist/*.zip
            dist/checksums.txt
          title: Version ${{ forgejo.ref_name }}
          prerelease: true
```

## Inputs

| Name | Default | Description |
| --- | --- | --- |
| `files` | required | Files to upload, one per line, see [Selecting files](#selecting-files). |
| `tag` | the tag that triggered the workflow | Tag of the release. |
| `title` | the tag | Title given to the release when it has to be created. |
| `body` | empty | Notes given to the release when it has to be created. |
| `draft` | `false` | Create the release as a draft when it does not exist yet. |
| `prerelease` | `false` | Mark the release as a prerelease when it has to be created. |
| `overwrite` | `true` | Replace a file already attached to the release under the same name. When `false`, the action fails before uploading anything. |
| `fail-on-unmatched` | `true` | Fail when a line of `files` matches nothing. When `false`, it only warns. |
| `token` | the automatic workflow token | Token allowed to write releases of the repository. |
| `server-url` | the current Forgejo instance | Base url of the Forgejo instance. |
| `repository` | the current repository | Repository owning the release, as `owner/name`. |

`title`, `body`, `draft` and `prerelease` only apply when the action creates the release. An existing release is left as it is.

## Outputs

| Name | Description |
| --- | --- |
| `release-id` | Identifier of the release. |
| `release-url` | Web page of the release. |
| `assets` | JSON array of the uploaded files, each with its `name` and download `url`. |

```yaml
    - uses: https://code.vexcited.com/forgejo/upload-release-assets@v1
      id: upload
      with:
        files: release/*

    - run: echo "published on ${{ steps.upload.outputs.release-url }}"
```

## Selecting files

Each line of `files` is resolved from the workspace.

- a file is uploaded as is.
- a directory uploads the files directly inside it, not its subdirectories.
- a pattern uses `*` for any characters within a folder, `?` for one character, and `**` for any number of folders, such as `dist/**/*.zip`.

Hidden files, whose names start with a dot, are skipped unless the pattern names them explicitly, so a stray `.DS_Store` is never published.

A file matched by several lines is uploaded once. Files are attached under their base name, so two files with the same name in different folders are rejected.

## Token

The automatic workflow token is used by default. When it is not allowed to write releases, the action fails with the http status and message returned by Forgejo. In that case, or to publish to another repository, pass a token that has write access to the repository:

```yaml
      with:
        files: release/*
        repository: owner/other-repository
        token: ${{ secrets.RELEASE_TOKEN }}
```

The token only ever travels in the authorization header of api requests. It is never printed.
