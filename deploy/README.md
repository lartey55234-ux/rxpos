# Running rxpos on your own server

One machine, always on, no cold starts. The database stays on Neon, so the
records have their own backups and the server is disposable.

## What you need

- A Linux VM with a public IP. Oracle Cloud's Always Free Ampere instance is
  free: 2 OCPU, 12 GB memory, 200 GB of storage.
- The `agent_key` private key on whoever is setting it up, and the matching
  public key on the machine.
- The `deploy_key` on the machine, registered as a **read-only deploy key** on
  the repository, so it can pull its own code.

## Setting it up

```bash
sudo DATABASE_URL="postgresql://..." ./deploy/setup-server.sh
```

It installs Node 24 and Caddy, creates the `rxpos` service account, checks out
the code, builds the counter UI, and puts a real TLS certificate in front of it.
Running it again is how you update the machine.

## The hostname

Without a domain, the script uses `<ip>.sslip.io`, which resolves back to that
address, so Let's Encrypt will issue a genuine certificate for it. Pass
`HOSTNAME_OVERRIDE=pharmacy.example.com` if you have a domain.

## The catch with Oracle's free tier

Oracle reclaims Always Free instances it considers idle: over a seven-day
period, CPU under 20%, network under 20% and memory under 20%. A pharmacy POS
is idle most of the day, so expect the instance to be stopped eventually. It is
stopped rather than deleted, and starting it again brings the site back. The
`watchdog` script below does that on a schedule.
