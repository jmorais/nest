# Docker usage

Quick instructions for running AvianVisitors with Docker (development):

1. Create a `.env` in the project root (or export env vars in your shell):

```
AV_REQUIRE_AUTH=0
AV_USER_AGENT="AvianVisitors/1.0"
BIRDNET_GO_URL="https://birds.cellar.home"
BIRDNET_GO_USER=""
BIRDNET_GO_PASS=""
GEMINI_API_KEY=""
EBIRD_API_KEY=""
```

2. Build and start the stack (app server on port 8080):

```bash
docker compose up --build -d
```

3. Visit the site: `http://localhost:8080/` (frontend). API endpoints are under `/api/`.

Run the pregen scripts (one-off) inside the helper container:

```bash
docker compose run --rm pregen python3 scripts/pregen.py --labels /path/to/labels.txt --gemini-key "$GEMINI_API_KEY"
```

Notes & caveats:
- The `Dockerfile` provides a PHP image with GD support. The compose setup runs a simple PHP development server to serve the site. It does not install heavyweight ML/image-removal tooling (e.g. `rembg`) by default — install that separately if you need the Wikipedia rembg fallback from `api/cutout.php`.
- The `pregen` service installs Python packages at container start in this template. For production you may want to create a dedicated image with pinned dependencies.
- Static files and PHP sources are mounted from the repo into the container at runtime.
