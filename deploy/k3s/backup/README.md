# Nightly backups to a Synology NAS

Every night at 02:30 (NZ time) a small job:

1. takes a safe copy of the Inkvoice database while the app keeps running,
2. encrypts it with your backup password and stores it on the NAS,
3. keeps 7 daily, 4 weekly and 6 monthly copies and deletes older ones,
4. checks that the stored backups are readable.

Backups are encrypted with [restic](https://restic.net). Without the backup
password nobody, including you, can open them, so store that password
somewhere safe outside the cluster, such as a password manager.

## One-time setup

### 1. On the Synology

1. **Create a shared folder:** Control Panel → Shared Folder → Create.
   Name it `inkvoice-backups`.
2. **Turn on NFS:** Control Panel → File Services → NFS → tick
   *Enable NFS service*, set the maximum protocol to NFSv4.1 → Apply.
3. **Let the k3s machine in:** Control Panel → Shared Folder → select
   `inkvoice-backups` → Edit → NFS Permissions → Create:
   - Hostname or IP: the SenseCAP's IP address
   - Privilege: Read/Write
   - Squash: *Map all users to admin*
   - Tick *Allow connections from non-privileged ports*
4. Note the **mount path** shown at the bottom of that window, usually
   `/volume1/inkvoice-backups`.

### 2. On the SenseCAP (once)

The machine needs the NFS client installed:

```bash
sudo apt-get install -y nfs-common
```

### 3. In the cluster

1. In `backup-cronjob.yaml`, set `server:` to the Synology's IP address and
   `path:` to the mount path from step 1.4.
2. Create the backup password (pick a long one and save it in your password
   manager first):

   ```bash
   kubectl create secret generic inkvoice-backup \
     --from-literal=RESTIC_PASSWORD='your-long-backup-password'
   ```

3. Install the job:

   ```bash
   kubectl apply -f deploy/k3s/backup/backup-cronjob.yaml
   ```

4. Run it once now instead of waiting for tonight:

   ```bash
   kubectl create job --from=cronjob/inkvoice-backup inkvoice-backup-test
   kubectl logs -f job/inkvoice-backup-test -c restic
   ```

   It worked if the log ends with `no errors were found`.

## Restoring

1. List the backups (run from any machine with access to the NAS share and
   restic installed, or from a pod like the job's):

   ```bash
   export RESTIC_REPOSITORY=/path/to/inkvoice-backups/inkvoice
   export RESTIC_PASSWORD='your-long-backup-password'
   restic snapshots
   ```

2. Restore the newest one (or replace `latest` with a snapshot ID):

   ```bash
   restic restore latest --target ./restored
   ```

   The database is at `./restored/snapshot/invoice.db`.

3. Put it back. Stop the app, open the data volume in a temporary pod, swap
   the file in, then start the app again:

   ```bash
   kubectl scale deployment inkvoice --replicas=0

   kubectl run inkvoice-restore --image=busybox:1.36 --restart=Never --overrides='
   {"spec":{"containers":[{"name":"restore","image":"busybox:1.36","command":["sleep","3600"],
     "volumeMounts":[{"name":"data","mountPath":"/data"}]}],
     "volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"inkvoice-data"}}]}}'
   kubectl wait --for=condition=Ready pod/inkvoice-restore

   # Remove the old database's leftover journal files. Left in place they
   # would be replayed onto the restored copy and corrupt it.
   kubectl exec inkvoice-restore -- rm -f /data/invoice.db-wal /data/invoice.db-shm
   kubectl cp ./restored/snapshot/invoice.db inkvoice-restore:/data/invoice.db

   kubectl delete pod inkvoice-restore
   kubectl scale deployment inkvoice --replicas=1
   ```

Test a restore every few months, into a separate test install, so you know
it works before you need it.
