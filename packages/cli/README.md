# qdag CLI

`qdag` records local experiment commands against the versioned `/api/v1`
registry, validates result manifests, and creates authenticated encrypted
backups.

Run `qdag --help` for command documentation. Personal tokens are stored in the
operating-system keyring when available. The fallback credential file and all
run state use owner-only permissions.
