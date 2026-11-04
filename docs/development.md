# Developing Orbit from source

This page is for people who build Orbit from a clone of the repository. To run
Orbit rather than build it, follow [Installing Orbit](installing.md).

## Building from source

Building is a developer task, not an install option, so the installer does
not offer it. Clone the repository and build:

```bash
git clone https://github.com/tomlawesome/orbit.git && cd orbit
```

Two scripts then matter, and each needs something the other can produce.
`bash scripts/configure.sh` runs inside the Orbit image, so it needs one: an
`ORBIT_IMAGE` in your environment (a registry digest, or the local tag
`build-container.sh` builds) or in `.env-orbit`; a local tag that has not
been built yet is refused. `bash scripts/build-container.sh` needs no
`.env-orbit`, so on a fresh checkout `bash scripts/deploy-container.sh
--build` does the whole job in the right order: build the image, run
configuration, start Orbit.

[Running a source checkout](#running-a-source-checkout), below, covers starting and
updating a checkout, and [Testing Orbit](testing.md#local-development) covers
a development setup.

## Running a source checkout

A checkout of the repository has the same scripts plus a few for building.
Build the image and start the stack with:

```sh
bash scripts/deploy-container.sh --build
```

It builds the image first, because `configure.sh` runs inside it, then
refreshes the settings, takes a backup if the database is already running,
starts everything and waits until it is healthy. Your secrets and data are
left as they are, and so is `.env-orbit` apart from `ORBIT_IMAGE`, which moves
to the image just built or pulled so a later `docker compose --env-file
.env-orbit up -d` starts the same build. `bash scripts/deploy-container.sh
--pull` does the same with the published build named in `ORBIT_IMAGE`
instead of building one: it pulls that digest first. Neither needs an
existing `.env-orbit`: `configure.sh` creates it once the image exists. To
build only, run `bash scripts/build-container.sh`; it builds the image
straight from the Dockerfile (the base Compose file has no build
instructions) and needs no `.env-orbit`.

To update a checkout and start it in one go:

```sh
./scripts/update-and-start.sh
```

It pulls the latest source (fast-forward only), then runs
`deploy-container.sh --build`.
