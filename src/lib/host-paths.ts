// The backup/restore shells (scripts/backup.sh and its siblings, #1211) run
// the engine with the deployment, an outside backup or secrets directory,
// and the bundle being read mounted at fixed container paths (build note
// E5), and pass the host path each one stands for. A path the engine prints
// is then one the operator can open on the host: "Orbit backup created:
// /srv/orbit/backups/orbit-....tar", never "/orbit-deploy/backups/...".

export const HOST_PATH_MOUNTS: readonly (readonly [mount: string, variable: string])[] = [
  ["/orbit-input/bundle.tar", "ORBIT_HOST_INPUT_FILE"],
  ["/orbit-deploy", "ORBIT_HOST_DEPLOY_DIR"],
  ["/orbit-backups", "ORBIT_HOST_BACKUP_DIR"],
  ["/orbit-secrets", "ORBIT_HOST_SECRETS_DIR"],
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces each mount path in `text` with the host path its variable names.
 * Only a whole path component matches (`/orbit-deploy/x`, `/orbit-deploy.`),
 * never a longer name that merely starts the same; a variable that is unset
 * or not absolute leaves its mount as it is. All mounts are replaced in one
 * pass over the original text, so a host path that itself contains a mount
 * name (`/srv/orbit-backups`) is never rewritten a second time.
 */
export function displayHostPaths(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const hostPaths = new Map<string, string>();
  for (const [mount, variable] of HOST_PATH_MOUNTS) {
    const hostPath = env[variable];
    if (hostPath && hostPath.startsWith("/")) hostPaths.set(mount, hostPath);
  }
  if (hostPaths.size === 0) return text;
  const alternatives = [...hostPaths.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const pattern = new RegExp(`(?:${alternatives.join("|")})(?=/|\\s|$|[).,;:])`, "g");
  return text.replace(pattern, (mount) => hostPaths.get(mount) ?? mount);
}
