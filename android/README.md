# Simorgh Android client

A small native client for a running Simorgh core. Three screens:

- **Agent** — chat with the core through `POST /api/v1/agent/execute`; shows the answer plus provenance
  (provider, request id, context ref) and handles `401/403/429/503` explicitly.
- **Status** — probes `GET /health` and `GET /api/v1/flock/status`, the two read-only checks that tell
  you a deployment is alive and which birds are healthy. This is the deployment aid: point it at a
  new target after `upm run simorgh -- deploy` / `upm run platform:smoke` and confirm the core answers.
  It does not deploy anything itself — deploys stay with the CLI, where the `deploy --mode cli --yes`
  gate and the plan output live.
- **Config** — base URL, bearer token, and an optional `userId` claim.

The app implements the canonical contract in [`../docs/api/CONTRACT.md`](../docs/api/CONTRACT.md). The
credential is the only identity: the optional `userId` is a claim the core validates, never an input
that decides ownership (A3 / AUTH-004).

## Build

This machine has no Gradle distribution cached, and Google's Maven endpoint is unreachable; the build
uses the Aliyun Google mirror declared in `settings.gradle.kts`.

```bash
cd projects/simorgh/android
# point Gradle at the installed SDK
printf 'sdk.dir=/home/shai/Android/Sdk\n' > local.properties

# if gradle-9.1.0-bin.zip was fetched to .openclaw/tmp, seed the wrapper cache:
mkdir -p ~/.gradle/wrapper/dists/gradle-9.1.0-bin
unzip -q /home/shai/personal/projects/.openclaw/tmp/gradle-9.1.0-bin.zip \
  -d ~/.gradle/wrapper/dists/gradle-9.1.0-bin

./gradlew assembleDebug     # APK: app/build/outputs/apk/debug/app-debug.apk
```

`local.properties` is gitignored. `ANDROID_HOME` needs no export when `sdk.dir` is set.

## Connect

- Emulator → host core: `http://10.0.2.2:8787` (`127.0.0.1` inside the emulator is the emulator itself).
- Physical device on the same LAN: use the host's LAN IP; set `NO_PROXY=127.0.0.1,localhost` on the
  host when probing locally.
- Any remote deployment should use HTTPS; the manifest enables cleartext only for local development.

Token choices mirror the server: a key from `SIMORGH_API_KEYS` executes as its mapped user; the
`SIMORGH_API_KEY` executes as the named `service` principal and cannot read per-user logs.

## Deliberate simplifications

- `ponytail:` HTTP is `HttpURLConnection` and JSON is `org.json` — both platform APIs, no OkHttp/Retrofit.
- `ponytail:` settings are app-private `SharedPreferences`, not Android Keystore. Upgrade before
  distributing to other people; fine for a solo operator's device.
- `ponytail:` raw status payloads are shown as text rather than pretty-printed typed views. Add typed
  views when the Status screen is used daily.
