# Off-host backup copies (rclone)

`deploy/backup/backup.sh` copies each night's backup to
`$PEN_BACKUP_RCLONE_REMOTE` when that variable is set. The remote itself is
defined by `rclone.conf` **in this directory** on the host
(`/srv/pen-playground/backup/rclone/rclone.conf`), which the `backup`
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

2. **Give it a key instead of a password**, from the app host:

   ```sh
   ssh-keygen -t ed25519 -f /root/.ssh/pen-backup -N ''
   # -s writes into the Storage Box's own .ssh/authorized_keys over SFTP.
   # Port 23 wants a plain one-line OpenSSH key (not RFC4716), which is what
   # ssh-keygen just produced.
   ssh-copy-id -s -i /root/.ssh/pen-backup.pub -p 23 uXXXXXX@uXXXXXX.your-storagebox.de
   # prove it, without a password prompt:
   ssh -p 23 -i /root/.ssh/pen-backup uXXXXXX@uXXXXXX.your-storagebox.de ls
   ```

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
   /srv/pen-playground/backup/rclone/ && chmod 600 …/pen-backup`); the
   container sees it at `/rclone/pen-backup`, which is what `key_file` names.

4. Point the stack at it and restart the service:

   ```sh
   cd /srv/pen-playground
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
`/srv/pen-playground/backups/2026-09-17/`, and run the ordinary restore —
`docker compose --profile backup run --rm backup /restore.sh 2026-09-17`
(docs/RUNBOOK.md → "Backups"). Nothing about the restore path is special to
having come from the remote.

**Never commit `rclone.conf` or the key.** Both live only on the host; this
directory ships with nothing but this README.
