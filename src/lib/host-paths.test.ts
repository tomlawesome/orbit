import { describe, expect, it } from "vitest";

import { displayHostPaths } from "./host-paths";

describe("displayHostPaths (#1211 E5: the engine prints host paths, not mount points)", () => {
  const env = {
    ORBIT_HOST_DEPLOY_DIR: "/srv/orbit",
    ORBIT_HOST_BACKUP_DIR: "/mnt/backups",
    ORBIT_HOST_SECRETS_DIR: "/etc/orbit-secrets",
    ORBIT_HOST_INPUT_FILE: "/home/op/orbit-20260101-000000.tar",
  };

  it("maps every mount the shells use back to its host path", () => {
    expect(displayHostPaths("Orbit backup created: /orbit-deploy/backups/orbit-1.tar", env)).toBe("Orbit backup created: /srv/orbit/backups/orbit-1.tar");
    expect(displayHostPaths("Orbit recovery bundle created: /orbit-backups/orbit-recovery-1.tar", env)).toBe(
      "Orbit recovery bundle created: /mnt/backups/orbit-recovery-1.tar",
    );
    expect(displayHostPaths("missing regular document KEK file at /orbit-secrets/document-kek", env)).toBe(
      "missing regular document KEK file at /etc/orbit-secrets/document-kek",
    );
    expect(displayHostPaths("Orbit backup is valid: /orbit-input/bundle.tar", env)).toBe("Orbit backup is valid: /home/op/orbit-20260101-000000.tar");
    expect(displayHostPaths("(/orbit-deploy/.orbit-secrets/document-kek-next exists).", env)).toBe("(/srv/orbit/.orbit-secrets/document-kek-next exists).");
  });

  it("leaves a longer name that only starts like a mount alone", () => {
    expect(displayHostPaths("/orbit-deployment/x and /orbit-backupsy", env)).toBe("/orbit-deployment/x and /orbit-backupsy");
  });

  it("changes nothing when the shell named no host path, or a relative one", () => {
    expect(displayHostPaths("at /orbit-deploy/backups", {})).toBe("at /orbit-deploy/backups");
    expect(displayHostPaths("at /orbit-deploy/backups", { ORBIT_HOST_DEPLOY_DIR: "relative/dir" })).toBe("at /orbit-deploy/backups");
  });

  it("does not read a replacement pattern out of the host path", () => {
    expect(displayHostPaths("at /orbit-deploy/x", { ORBIT_HOST_DEPLOY_DIR: "/srv/$&$1" })).toBe("at /srv/$&$1/x");
  });
});
