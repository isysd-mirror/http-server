# guld http server

_beta_

TLDR; Handle read (GET) and write (POST) requests from guld peers.

This package is a git via HTTP server that is meant to be run locally, and to cache the private and eventually public internets.

### Features

 + run individualized and security scoped workers for each active guld user on the node
 + write to your individual branch with gpg signed commit
 + write to a group branch with weighted signatures (multiple per commit!)
 + Create a session authentication password by writing to specific /etc/htpasswd file
 + Read any files your user can read, after authenticating using basic auth

### Config

| path        | format | description        |
|-----------------|--------------|--------------------------------------|
| `/etc/fingerprint` | `$OpenPGPFingerprint:$weight` | An OpenPGP and user weighting flat file. |
| `/etc/htpasswd` | `$username:$sha512HashedSaltedPassword` | A normal [htpasswd](http://www.htaccesstools.com/articles/htpasswd/) file, mapping users to SHA512, salted hashes |
| `/etc/nginx` | Nginx config files | Nginx or a similar http server is recommended, since this one spawns child processes listening on unix sockets. |
| `/@$user` | Version controlled directory | The user's home directories use scoped namespaces (@name instead of /home/name). Users may have their own copies of all system files and more. |
| `/var/log/guld/@$user` | log file directory | The user's worker logs activites here. |

### Usage

To enhance security and privacy, each active user gets their own worker process, running under their system user and group id.

These are started by a super server that must be run by root or sudo.

`sudo node super-server.js`

This will start a child worker for the public guld user account, as well as any users present in `/etc/htpasswd`.

The super server will listen for changes to htpasswd and start new workers as they register session passwords.

It has a basic TTY command prompt for restarting workers and cleaning up.

### Web Authentication

This server allows full read and write capabilities over the web, including a natural login experience.

When a user wishes to authenticate with a peer, the client goes through the following steps:

1. Unlock PGP key
2. (background) Either use cached htpasswd or register a new one with the node
3. (background) Send Basic Auth request with username and htpasswd result
4. redirect user to "logged in" section if #3 passes

After this, the browser should cache the session password until the node revokes it, or a new is registered (step 2). This cache is typically cleared on browser restart.

### Corporate Management Example

Lets say you set up Acme-LTD branch for the hypothetical acme ltd company. The cap table for Acmt-LTD stock is transcribed into `/@acme-ltd/etc/fingerprint/` weighing each key to the number of voting shares that person has.

Then the acme branch will not be able to be written to unless a majority of voting shares have signed. Each commit would accumulate more signatures in it's `gpgsig` header until the critical number is reached, and the commit can be merged to the official acme-ltd branch.
