# Installing Inkvoice with Portainer

Menu names below match recent Portainer versions; older ones may word them
slightly differently.

## Step 1 — Make two passwords

You need two secret values:

- **JWT_SECRET**: a long random string the app uses to sign logins. Nobody
  types it, so make it long. On a Mac, open Terminal and run
  `openssl rand -base64 48`, then copy the output.
- **ADMIN_PASS**: the password you will log in with. Save it in your password
  manager.

## Step 2 — Store them in Portainer

1. Open Portainer and click your **k3s environment**.
2. Left menu: **ConfigMaps & Secrets** → **Add with form**.
3. Namespace: **default**.
4. Name: `inkvoice`
5. Configuration type: **Secret**.
6. Add two entries:
   - Key `JWT_SECRET`, value: the long string from step 1
   - Key `ADMIN_PASS`, value: your login password
7. Click **Create**.

## Step 3 — Install the app

1. Open
   https://raw.githubusercontent.com/heyronmar/inkvoice/main/deploy/k3s/portainer-install.yaml
   and copy everything on the page.
2. In Portainer, left menu: **Applications** → **Create from manifest**
   (some versions call it **Create from code**).
3. Namespace: **default**. Paste the text into the editor.
4. Click **Deploy**.

## Step 4 — Wait for it to start

1. Left menu: **Applications** → click **inkvoice**.
2. The first start downloads the app, which can take a few minutes on a
   SenseCAP. Wait until it shows **Running** with 1 of 1 ready.

## Step 5 — Open it

In a browser on your home network, go to:

`http://<your-SenseCAP-IP>:30080`

Log in as **admin** with the ADMIN_PASS from step 1, then follow the
setup and pick **New Zealand**.

## Updating later

Every change saved to `main` on GitHub builds a new image. To switch to it,
open **Applications** → **inkvoice** and click **Redeploy** (or restart the
pod). Your data is kept on its volume.

## If something goes wrong

- **Stuck on "Pending":** the volume could not be created. Check that the
  `local-path` storage class exists (Portainer → **Volumes** / Storage).
- **Restarting over and over:** open the app's **Logs**. The usual cause is
  the `inkvoice` secret missing or a key name typed differently (the keys
  are case-sensitive).
- **Page does not open:** make sure you used port **30080** and the IP of a
  k3s machine, and that nothing else already uses port 30080.
