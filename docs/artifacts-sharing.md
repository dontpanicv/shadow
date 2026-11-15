# Sharing artifacts publicly

Shadow can stay private, for example on a VPN, while the links of public artifacts open for anyone. A second host,
such as `a.example.com`, reaches Shadow through a Cloudflare Tunnel and answers only artifact links:

```text
anyone ──https──▶ Cloudflare ──tunnel, outbound from the Shadow machine──▶ cloudflared ──▶ 127.0.0.1:<port> (Shadow)
members ────────▶ shadow.example.com (private) ──▶ proxy ──▶ 127.0.0.1:<port> (Shadow)
```

The Shadow machine needs no public address and no open port. Three layers keep the rest of Shadow private:

1. The tunnel's ingress passes only `/<name>`, `/<name>/content`, and `/<name>/rpc`, and answers `404` to the rest.
2. Shadow answers only those routes on the public host, and only for public artifacts. Members artifacts keep their
   link on Shadow's own address.
3. Shadow listens on `127.0.0.1` (`host` in `shadow.toml`), so only the proxy and the tunnel reach it.

## Set it up

With the `cf` CLI, signed in to the account of the domain:

1. Create a tunnel whose configuration Cloudflare keeps: `cf tunnels cloudflared create` with `name` and
   `config_src: "cloudflare"`.
2. Set its ingress with `cf tunnels config update`, with the public host and Shadow's port:

   ```json
   {
     "ingress": [
       {
         "hostname": "a.example.com",
         "path": "^/[a-z]+(-[a-z]+){1,3}(/content|/rpc)?$",
         "service": "http://127.0.0.1:3000"
       },
       { "service": "http_status:404" }
     ]
   }
   ```

   The path is anchored, and a name has no `.` or `/`, so paths such as `/x-y/../login` do not pass.
3. Add a proxied DNS record: `a` CNAME `<tunnel id>.cfargotunnel.com`.
4. On the Shadow machine: `brew install cloudflared`, put the tunnel's token in `config/share-tunnel.token`, and run
   `scripts/install-share-tunnel.sh`.
5. In `shadow.toml`, set `share_url = "https://a.example.com"`, and restart Shadow.

Check from a device outside the private network: a public artifact's link opens, and `/`, `/login`, and
`/api/v1/me` on the public host answer `404`.
