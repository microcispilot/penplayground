# Off-host backup copies (rclone)

`deploy/backup/backup.sh` copies each night's backup to
`$PEN_BACKUP_RCLONE_REMOTE` when that variable is set. The remote itself is
defined by `rclone.conf` **in this directory** on the host
(`/srv/pen-<env>/backup/rclone/rclone.conf`), which the `backup`
container mounts read-only at `/rclone`.

Unset `PEN_BACKUP_RCLONE_REMOTE` (the default) and backups stay on the host
only — which is a single disk, and therefore not yet a backup. Set it up.

## Hetzner Storage Box over SFTP (what this deployment uses)

Ordering costs money and needs the Hetzner account, so step 1 is the owner's;
everything after it is copy-paste on the app host.

1. **Order the box** — Hetzner Cloud Console → Storage Boxes → Create. **BX11**
   (1 TB, ~€3.20/month + VAT) is far more than this stack will use: a night's
   backup is a compressed Postgres dump plus `/data`, and only 14 are kept.
   Unlimited traffic, 10 parallel connections, snapshots and sub-accounts are
   all included, and there is no minimum term — it can be cancelled any time.

   Then, in the box's settings, enable **SSH support**. This is the step that
   is easy to miss: it opens **port 23** (port 22 is not used for interactive
   access), and until it is on, every command below fails with a connection
   error. It can take a few minutes to take effect.

   Note the username (`uXXXXXX`) and host (`uXXXXXX.your-storagebox.de`).

   > **The Console cannot add an SSH key to a box that already exists.** A key
   > can only be *chosen at creation time*; afterwards Hetzner's own docs say
   > "SSH keys cannot be added through the Console; you must manually add them
   > to the host server afterward"
   > ([creating a Storage Box](https://docs.hetzner.com/storage/storage-box/getting-started/creating-a-storage-box/)).
   >
   > The **project** SSH-key list in the Console (the page with the tabs
   > *SSH keys · S3 credentials · API tokens · Certificates · Members*) is a
   > decoy here: those keys are for creating **servers** and have nothing to do
   > with a Storage Box's authorised keys. A key added there is accepted,
   > displayed with the right fingerprint, and still rejected by the box —
   > which looks exactly like a broken key and costs an hour to diagnose.
   >
   > So for an existing box the password is the only way in: **Reset Password**
   > on the box, then step 2. Rotate it again afterwards if you like; the key
   > is what the backups use.

2. **Give it a key instead of a password**, from the app host:

   ```sh
   ssh-keygen -t ed25519 -f /root/.ssh/pen-backup -N ''

   # Hetzner's own helper on port 23 — asks for the Storage Box password once:
   cat /root/.ssh/pen-backup.pub \
     | ssh -p 23 uXXXXXX@uXXXXXX.your-storagebox.de install-ssh-key
   # (equivalently, on OpenSSH 8.5+: ssh-copy-id -s -p 23 uXXXXXX@uXXXXXX.your-storagebox.de)

   # prove it, with no password prompt this time:
   ssh -p 23 -i /root/.ssh/pen-backup uXXXXXX@uXXXXXX.your-storagebox.de ls
   ```

   Port 22 is always on but is SFTP/SCP only (no interactive access) and wants
   RFC4716-format keys; port 23 is the one **SSH support** enables and takes an
   ordinary one-line OpenSSH key, which is what `ssh-keygen` just produced.
   **External reachability** must also be on to reach the box from outside
   Hetzner's network.

3. Write `rclone.conf` next to this README (`chmod 600`):

   ```ini
   [hetzner]
   type = sftp
   host = uXXXXXX.your-storagebox.de
   user = uXXXXXX
   port = 23
   key_file = /rclone/pen-backup
   shell_type = unix
   ```

   Copy the **private** key here too (`cp /root/.ssh/pen-backup
   /srv/pen-<env>/backup/rclone/ && chmod 600 …/pen-backup`); the
   container sees it at `/rclone/pen-backup`, which is what `key_file` names.

4. Point the stack at it and restart the service:

   ```sh
   cd /srv/pen-<env>
   echo 'PEN_BACKUP_RCLONE_REMOTE=hetzner:pen-playground' >> .env
   docker compose --profile backup up -d backup
   docker compose --profile backup run --rm backup /backup.sh   # prove it now
   ```

5. Verify from the host:

   ```sh
   docker compose --profile backup run --rm --entrypoint sh backup -c \
     'rclone ls hetzner:pen-playground | tail'
   ```

Rotation is mirrored: the script deletes remote files older than
`PEN_BACKUP_KEEP_DAYS` after each successful copy.

> Steps 2–5 need the `backup` service to exist on the host, which happens at
> the first `deploy/deploy.sh` that carries it. Order the box whenever; wire it
> up with (or after) that deploy.

## Getting the data back when the host is gone

This is the scenario the off-host copy exists for, so it is worth knowing the
shape of it before you need it. From any machine with `rclone` and the private
key:

```sh
rclone copy hetzner:pen-playground/2026-09-17 ./restore-2026-09-17 -P
ls restore-2026-09-17            # postgres.dump  data.tar.gz  manifest.txt  SHA256SUMS
( cd restore-2026-09-17 && sha256sum -c SHA256SUMS )
```

Then stand the stack up on the new host as far as "secrets in place, `docker
compose up -d postgres`", copy that directory into
`/srv/pen-<env>/backups/2026-09-17/`, and run the ordinary restore —
`docker compose --profile backup run --rm backup /restore.sh 2026-09-17`
(docs/RUNBOOK.md → "Backups"). Nothing about the restore path is special to
having come from the remote.

**Never commit `rclone.conf` or the key.** Both live only on the host; this
directory ships with nothing but this README.
