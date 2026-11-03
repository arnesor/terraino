# Security policy

## Reporting a vulnerability

Please do not report security problems in public issues, discussions or pull requests.
Report them privately through GitHub's [private vulnerability reporting](https://github.com/arnesor/terraino/security/advisories/new)
(the **Security** tab, then **Report a vulnerability**).

Say what the problem is, how to reproduce it, and what an attacker could do with it.
You will get an answer as soon as possible,
and the fix will be published together with a security advisory that credits you,
unless you would rather not be named.

## Scope

- The viewer and the results Worker deployed at <https://terraino.arnesor.workers.dev>
  (`viewer/` and `viewer/worker/`).
- The Python pipeline (`src/terraino/`) and the OCAD exporter (`tools/ocad-export/`).

Only the latest version on `main`, and the deployed site, get security fixes.

Vulnerabilities in a dependency should be reported to that project.
Report them here as well if Terrain-O uses the dependency in a way that makes it exploitable.
