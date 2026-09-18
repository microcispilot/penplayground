# Off-host backup copies (rclone)

`deploy/backup/backup.sh` copies each night's backup to
`$PEN_BACKUP_RCLONE_REMOTE` when that variable is set. The remote itself is
defined by `rclone.conf` **in this directory** on the host
(`/srv/pen-playground/backup/rclone/rclone.conf`), which the `backup`
container mounts read-only at `/rclone`.

Unset `PEN_BACKUP_RCLONE_REMOTE` (the default) and backups stay on the host
only — which is a single disk, and therefore not yet a backup. Set it up.

## Hetzner Storage Box over SFTP (what this deployment uses)

1. Order a Storage Box (BX11 is enough: 1 TB) in the Hetzner console, and in
   its settings enable **SSH support**. Note the username (`uXXXXXX`) and host
   (`uXXXXXX.your-storagebox.de`).

2. Give it a key instead of a password, from the app host:

   ```sh
   ssh-keygen -t ed25519 -f /root/.ssh/pen-backup -N ''
   # Storage Boxes accept an upload over SSH into .ssh/authorized_keys:
   ssh-copy-id -s -i /root/.ssh/pen-backup.pub -p 23 uXXXXXX@uXXXXXX.your-storagebox.de
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

**Never commit `rclone.conf` or the key.** Both live only on the host; this
directory ships with nothing but this README.
