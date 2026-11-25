// O2-Q11 (#1151): the single place the Tika version is pinned. build.mjs (the
// Tika server zip it downloads) and cli.ts (the Docker image and jar filename
// it looks for) both read it from here instead of each hard-coding "4.0.0",
// so bumping the stack's pinned Tika version cannot update one file and
// silently leave the other behind.
export const TIKA_VERSION = "4.2.0";

// The Docker image's tag: the release plus the image's rebuild number
// ("4.2.0-2" is Tika 4.2.0, image build 2; #794). The server zip and jar are
// published per release only, so they keep TIKA_VERSION.
export const TIKA_IMAGE_TAG = "4.2.0-2";
