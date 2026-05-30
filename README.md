# AvianVisitors — Environment Variables

This repository contains the AvianVisitors web APIs and helper scripts. Several runtime behaviours and external integrations are controlled via environment variables. Below is a concise reference for every environment variable used in this project.

## Environment variables

- `AV_USER_AGENT`
  - Purpose: Optional User-Agent header for Wikipedia requests.
  - Default: `AvianVisitors/1.0`
  - Used in: `api/cutout.php`, `api/wiki.php`

- `AV_REQUIRE_AUTH`
  - Purpose: When set to `1`, admin-facing endpoints require an `Authorization` header (use Caddy `basic_auth` or a similar front proxy).
  - Default: not set (no auth enforced)
  - Used in: `api/config.php`, `api/birdnet-status.php`

- `BIRDNET_GO_URL`
  - Purpose: Base URL of your BirdNET-Go instance (no trailing slash).
  - Default: `https://birds.cellar.home`
  - Used in: `api/birdnet-api.php`, `api/spectrogram.php`, `api/recording.php`

- `BIRDNET_GO_USER`
  - Purpose: Optional Basic Auth username for BirdNET-Go.
  - Default: empty
  - Used in: `api/birdnet-api.php`, `api/spectrogram.php`, `api/recording.php`

- `BIRDNET_GO_PASS`
  - Purpose: Optional Basic Auth password for BirdNET-Go.
  - Default: empty
  - Used in: `api/birdnet-api.php`, `api/spectrogram.php`, `api/recording.php`

- `GEMINI_API_KEY`
  - Purpose: API key for Google Gemini / Generative Language used by the image-generation scripts.
  - Required: Yes for `scripts/pregen.py` and `scripts/pregen_batch.py` (scripts will exit with an error if missing).
  - Set via: environment variable or passed with `--gemini-key` to the scripts.
  - Used in: `scripts/pregen.py`, `scripts/pregen_batch.py`

- `EBIRD_API_KEY`
  - Purpose: eBird API token used when filtering species lists by eBird region.
  - Required: Only when using `--ebird-region` in the pregen scripts.
  - Set via: environment variable or passed with `--ebird-key` to the scripts.
  - Used in: `scripts/pregen.py`, `scripts/pregen_batch.py`

## Example `.env` snippet

Put sensitive keys into your system's secret store, systemd unit, or an env file that is never committed to git. Example:

```
AV_USER_AGENT="AvianVisitors/1.0"
AV_REQUIRE_AUTH="1"
BIRDNET_GO_URL="https://birds.cellar.home"
BIRDNET_GO_USER=""
BIRDNET_GO_PASS=""
GEMINI_API_KEY="sk-..."
EBIRD_API_KEY="your_ebird_token"
```

## Notes & deployment tips
- For forwarded/public deployments: set `AV_REQUIRE_AUTH=1` and protect `/avian/api/` with Caddy `basic_auth` or an equivalent reverse-proxy authentication.
- Place server-side env vars where your PHP-FPM / Caddy process inherits them (systemd unit, `/etc/environment`, or pool configuration), not in the webroot.
- Keep API keys out of repository history — prefer system-level secrets or a vault.
- Image-generation scripts require `GEMINI_API_KEY` to run; the web API itself does not need it unless you run the pregen scripts.

## Files that reference env variables

- `api/cutout.php`
- `api/wiki.php`
- `api/config.php`
- `api/birdnet-status.php`
- `api/birdnet-api.php`
- `api/spectrogram.php`
- `api/recording.php`
- `scripts/pregen.py`
- `scripts/pregen_batch.py`

If you want, I can also add a `README.env.example` or a short section describing how to set these variables for `systemd` / `php-fpm` deployments. Want me to add that?
