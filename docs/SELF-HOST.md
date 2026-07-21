# Self-hosting Gaminus

Gaminus is self-hosted from the **GitHub Releases** server artifact only:

<https://github.com/devswha/gaminus/releases>

The canonical artifact is
`gaminus-server-<version>-linux-x64-node22.tar.gz`, accompanied by an
artifact with the same name plus `.sha256`. Do not substitute a package
registry, container image, desktop delivery, or an unverified source build.

## Supported target and filesystem layout

The first supported artifact target is Linux on x86_64 with glibc 2.35 or
newer and a Node.js 22 runtime. It is a server artifact only.

| Path | Purpose |
|---|---|
| `~/.local/share/gaminus` | Canonical Git checkout for source review and manual upstream intake. It is not a release payload. |
| `~/.gaminus/releases/<version>` | Immutable unpacked server artifacts. |
| `~/.gaminus/current` | Symlink to the release used by the service. |
| `~/.gaminus/data` | Persistent application data, including user-managed database, assets, and cache paths. |
| `~/.config/systemd/user/gaminus.service` | Per-user systemd service. |

A release deployment must never create, replace, or delete the checkout.
Likewise, replacing a release must not delete `~/.gaminus/data`.

Before the first deployment, confirm the host contract:

```sh
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
getconf GNU_LIBC_VERSION    # requires glibc 2.35 or newer
node --version              # requires v22
```

Use the release-install procedure in [INSTALL.md](INSTALL.md) to verify the
checksum, unpack a versioned release, install `gaminus.service`, and activate
the initial `current` link.

## Service operations

Gaminus runs as the per-user `gaminus.service`; root privileges and a
system-wide unit are not required.

```sh
systemctl --user status gaminus.service
systemctl --user restart gaminus.service
journalctl --user -u gaminus.service -f
curl --fail http://127.0.0.1:3001/health
```

Use `loginctl enable-linger "$USER"` only when the host policy permits the
service to continue after logout.

Keep the service on loopback unless remote access is deliberately required.
Prefer a trusted VPN or an SSH tunnel; do not expose the server by raw public
port forwarding.

```sh
ssh -N -L 3001:127.0.0.1:3001 user@server
```

## Cutover to a verified release

A cutover changes only the `current` symlink and then restarts the service.
Download and checksum-verify the next artifact exactly as described in
[INSTALL.md](INSTALL.md); do not use a moving `latest` URL.

1. Record the active release before touching `current`.
2. Unpack the verified artifact into its new
   `~/.gaminus/releases/<version>` directory.
3. Confirm that the expected server entry point is present.
4. Atomically replace `current`, restart the service, and check both systemd
   state and the health endpoint.
5. Keep the prior release directory until the new release is accepted.

```sh
RUNTIME="$HOME/.gaminus"
VERSION=<approved-version>
RELEASE_DIR="$RUNTIME/releases/$VERSION"
PREVIOUS="$(readlink -f "$RUNTIME/current")"

test -f "$RELEASE_DIR/dist-server/server/index.js"
printf '%s\n' "$PREVIOUS" > "$RUNTIME/previous-release"
ln -s "$RELEASE_DIR" "$RUNTIME/current.next"
mv -Tf "$RUNTIME/current.next" "$RUNTIME/current"

systemctl --user restart gaminus.service
systemctl --user --no-pager --full status gaminus.service
curl --fail http://127.0.0.1:3001/health
```

If the service or health check fails, perform the rollback immediately rather
than troubleshooting against a partially accepted release.

## Rollback

`previous-release` contains the release path captured by the cutover commands.
Validate it is an installed release before atomically restoring it.

```sh
RUNTIME="$HOME/.gaminus"
PREVIOUS="$(<"$RUNTIME/previous-release")"

case "$PREVIOUS" in
  "$RUNTIME"/releases/*) ;;
  *) printf '%s\n' "Refusing an unsafe rollback target: $PREVIOUS" >&2; exit 1 ;;
esac
test -f "$PREVIOUS/dist-server/server/index.js"

ln -s "$PREVIOUS" "$RUNTIME/current.rollback"
mv -Tf "$RUNTIME/current.rollback" "$RUNTIME/current"
systemctl --user restart gaminus.service
systemctl --user --no-pager --full status gaminus.service
curl --fail http://127.0.0.1:3001/health
```

Record the failed version and the rollback result in the deployment record.
Do not remove either release until the rollback health check succeeds.

## Removal boundary

To remove the service and release payload while preserving user data:

```sh
systemctl --user disable --now gaminus.service
rm -f "$HOME/.config/systemd/user/gaminus.service"
systemctl --user daemon-reload
rm -rf "$HOME/.gaminus/releases"
rm -f "$HOME/.gaminus/current" "$HOME/.gaminus/previous-release"
```

This intentionally leaves `~/.gaminus/data` and
`~/.local/share/gaminus` untouched. Back up or remove either path only
through an explicit, separately reviewed data-retention decision.

## Source and upstream boundaries

The checkout at `~/.local/share/gaminus` is for source review and deliberate
maintenance work. It is never the service working directory and is never
updated as part of a release cutover. Follow [UPSTREAM.md](UPSTREAM.md) for
manual, selective upstream intake; automated mirroring or synchronization is
not permitted.