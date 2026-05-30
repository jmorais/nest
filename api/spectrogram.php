<?php
// AvianVisitors - proxies spectrogram images from BirdNET-Go's API.
//
// Usage:
//   /avian/api/spectrogram.php?sci=<scientific name>
//   /avian/api/spectrogram.php?file=<detection id>
//
// Modern BirdNET-Go spectrogram endpoint:
//   GET /api/v2/spectrogram/<detection_id>
//
// Configure via environment variables:
//   BIRDNET_GO_URL   - base URL of your BirdNET-Go instance
//   BIRDNET_GO_USER  - optional Basic Auth username
//   BIRDNET_GO_PASS  - optional Basic Auth password

declare(strict_types=1);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

$BIRDNET_GO_URL  = rtrim(getenv('BIRDNET_GO_URL') ?: 'https://birds.cellar.home', '/');
$BIRDNET_GO_USER = getenv('BIRDNET_GO_USER') ?: '';
$BIRDNET_GO_PASS = getenv('BIRDNET_GO_PASS') ?: '';
$HTTP_TIMEOUT    = 15;

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

$sci  = trim((string)($_GET['sci'] ?? ''));
$file = trim((string)($_GET['file'] ?? ''));

if ($sci === '' && $file === '') {
  http_response_code(400);
  header('Content-Type: text/plain; charset=utf-8');
  echo 'sci or file parameter required';
  exit;
}

// BirdNET-Go scientific names: "Genus species" or "Genus species subspecies".
if ($sci !== '' && !preg_match('/^[A-Za-z]{2,40}(?:[ ][a-z]{2,40}){1,3}$/', $sci)) {
  http_response_code(400);
  header('Content-Type: text/plain; charset=utf-8');
  echo 'invalid sci';
  exit;
}

// In the updated version, file should be a BirdNET-Go detection ID.
// Example: /avian/api/spectrogram.php?file=7020
if ($file !== '' && !preg_match('/^\d+$/', $file)) {
  http_response_code(400);
  header('Content-Type: text/plain; charset=utf-8');
  echo 'invalid file parameter; expected BirdNET-Go detection id';
  exit;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Build a stream context for BirdNET-Go requests.
 */
function bg_context(int $timeout = 15, string $accept = '*/*'): mixed {
  global $BIRDNET_GO_USER, $BIRDNET_GO_PASS;

  $headers = ['Accept: ' . $accept];

  if ($BIRDNET_GO_USER !== '') {
    $creds = base64_encode($BIRDNET_GO_USER . ':' . $BIRDNET_GO_PASS);
    $headers[] = 'Authorization: Basic ' . $creds;
  }

  return stream_context_create([
    'http' => [
      'method'          => 'GET',
      'timeout'         => $timeout,
      'ignore_errors'   => true,
      'follow_location' => 1,
      'header'          => $headers,
    ],
    'ssl' => [
      'verify_peer'       => false,
      'verify_peer_name'  => false,
      'allow_self_signed' => true,
    ],
  ]);
}

/**
 * Fetch JSON from a BirdNET-Go API path.
 */
function bg_json(string $path, array $query = []): mixed {
  global $BIRDNET_GO_URL, $HTTP_TIMEOUT;

  $url = $BIRDNET_GO_URL . $path;

  if ($query) {
    $url .= '?' . http_build_query($query);
  }

  $body = @file_get_contents(
    $url,
    false,
    bg_context($HTTP_TIMEOUT, 'application/json')
  );

  if ($body === false) {
    return null;
  }

  $data = json_decode($body, true);

  return json_last_error() === JSON_ERROR_NONE ? $data : null;
}

/**
 * Return the first list-like detection array from a BirdNET-Go response.
 */
function extract_detection_list(mixed $raw): array {
  if (!is_array($raw)) {
    return [];
  }

  if (isset($raw['detections']) && is_array($raw['detections'])) {
    return $raw['detections'];
  }

  if (isset($raw['data']) && is_array($raw['data'])) {
    return $raw['data'];
  }

  if (isset($raw['results']) && is_array($raw['results'])) {
    return $raw['results'];
  }

  if (isset($raw[0]) && is_array($raw[0])) {
    return $raw;
  }

  return [];
}

/**
 * Try to get the scientific name from a detection object.
 */
function detection_sci(array $d): string {
  return (string)(
    $d['scientificName']
    ?? $d['scientific_name']
    ?? $d['sci']
    ?? ''
  );
}

/**
 * Try to get the detection ID from a detection object.
 */
function detection_id(array $d): ?string {
  if (!isset($d['id'])) {
    return null;
  }

  $id = (string)$d['id'];

  return preg_match('/^\d+$/', $id) ? $id : null;
}

/**
 * Choose the best detection for a species.
 * Current behavior: highest confidence among matching detections.
 */
function find_best_detection_id(array $det_list, string $sci): ?string {
  $best = null;

  foreach ($det_list as $d) {
    if (!is_array($d)) {
      continue;
    }

    $d_sci = detection_sci($d);

    if ($d_sci !== '' && strcasecmp($d_sci, $sci) !== 0) {
      continue;
    }

    $id = detection_id($d);

    if ($id === null) {
      continue;
    }

    if ($best === null) {
      $best = $d;
      continue;
    }

    $best_conf = (float)($best['confidence'] ?? 0);
    $this_conf = (float)($d['confidence'] ?? 0);

    if ($this_conf > $best_conf) {
      $best = $d;
    }
  }

  return $best !== null ? detection_id($best) : null;
}

/**
 * Send a JSON error and exit.
 */
function json_error(int $status, array $payload): never {
  http_response_code($status);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode($payload);
  exit;
}

// ---------------------------------------------------------------------------
// Resolve spectrogram URL
// ---------------------------------------------------------------------------

$spectrogram_url = null;

// Mode 1: direct detection ID.
// Example: /avian/api/spectrogram.php?file=7020
if ($file !== '') {
  $spectrogram_url = $BIRDNET_GO_URL . '/api/v2/spectrogram/' . rawurlencode($file);
} else {
  // Mode 2: scientific name.
  // First try /api/v2/detections filtered by species.
  $raw = bg_json('/api/v2/detections', [
    'species'    => $sci,
    'numResults' => 50,
    'offset'     => 0,
    'sort'       => 'date_desc',
  ]);

  // Fallback: try recent detections and filter locally.
  if ($raw === null) {
    $raw = bg_json('/api/v2/detections/recent', [
      'hours' => 1000000,
    ]);
  }

  if (isset($_GET['debug'])) {
    $det_list = extract_detection_list($raw);
    $first = $det_list[0] ?? null;

    header('Content-Type: application/json; charset=utf-8');
    echo json_encode([
      'sci'        => $sci,
      'raw_type'   => gettype($raw),
      'top_keys'   => is_array($raw) ? array_keys($raw) : null,
      'count'      => count($det_list),
      'first_keys' => is_array($first) ? array_keys($first) : null,
      'first_item' => $first,
      'raw'        => $raw,
    ], JSON_PRETTY_PRINT);
    exit;
  }

  $det_list = extract_detection_list($raw);
  $spectrogram_id = find_best_detection_id($det_list, $sci);

  if ($spectrogram_id === null) {
    json_error(404, [
      'error' => 'no spectrogram found for ' . $sci,
      'hint'  => 'add &debug=1 to the URL to inspect the BirdNET-Go response',
    ]);
  }

  $spectrogram_url = $BIRDNET_GO_URL . '/api/v2/spectrogram/' . rawurlencode($spectrogram_id);
}

if ($spectrogram_url === null) {
  json_error(500, [
    'error' => 'could not resolve spectrogram URL',
  ]);
}

// ---------------------------------------------------------------------------
// Proxy the spectrogram image from BirdNET-Go
// ---------------------------------------------------------------------------

$upstream = @fopen(
  $spectrogram_url,
  'rb',
  false,
  bg_context($HTTP_TIMEOUT, 'image/*,*/*')
);

if ($upstream === false) {
  http_response_code(502);
  header('Content-Type: text/plain; charset=utf-8');
  echo 'could not connect to BirdNET-Go spectrogram endpoint';
  exit;
}

$meta = stream_get_meta_data($upstream);
$wrapper_data = $meta['wrapper_data'] ?? [];

$status_code = 200;
$content_len = null;
$content_type = null;

foreach ($wrapper_data as $header_line) {
  if (preg_match('#^HTTP/\S+\s+(\d+)#i', $header_line, $hm)) {
    $status_code = (int)$hm[1];
  }

  if (preg_match('/^Content-Length:\s*(\d+)/i', $header_line, $hm)) {
    $content_len = (int)$hm[1];
  }

  if (preg_match('/^Content-Type:\s*(.+)$/i', $header_line, $hm)) {
    $content_type = trim($hm[1]);
  }
}

if ($status_code === 404) {
  fclose($upstream);
  http_response_code(404);
  header('Content-Type: text/plain; charset=utf-8');
  echo 'spectrogram not found on BirdNET-Go';
  exit;
}

if ($status_code >= 400) {
  fclose($upstream);
  http_response_code(502);
  header('Content-Type: text/plain; charset=utf-8');
  echo 'upstream error: HTTP ' . $status_code;
  exit;
}

if ($content_type === null || stripos($content_type, 'image/') !== 0) {
  $content_type = 'image/png';
}

http_response_code(200);
header('Content-Type: ' . $content_type);
header('Cache-Control: public, max-age=86400');

if ($content_len !== null) {
  header('Content-Length: ' . $content_len);
}

while (!feof($upstream)) {
  $chunk = fread($upstream, 65536);

  if ($chunk === false) {
    break;
  }

  echo $chunk;
  flush();
}

fclose($upstream);