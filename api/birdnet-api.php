<?php
// AvianVisitors - JSON facade over BirdNET-Go's HTTP API. Read-only.
// Symlinked into your Caddy (or other) site root at /avian/api/.
//
// Configure the BirdNET-Go base URL below, or set the BIRDNET_GO_URL
// environment variable (useful in Docker / systemd environments).
//
// Endpoints (?action=...):
//   stats       - totals (detections, unique species, today, last hour)
//   lifelist    - every species with first_seen, last_seen, total_count
//   recent      - &hours=N (default 24): species heard in the window
//   species     - &sci=<sci_name>: per-species detail page
//   timeseries  - &days=N: daily detection counts per species
//   firstseen   - every species' earliest detection
//
// JSON output structure is intentionally identical to the original
// birds.db edition so existing frontends need no changes.
//
// BirdNET-Go API endpoints used:
//   GET /api/v2/analytics/species/summary  - all-time species list
//   GET /api/v2/analytics/species/daily    - today's species list
//   GET /api/v2/detections                 - paginated detections
//   GET /api/v2/detections/recent          - recent detections by hours (fallback: summary filtered)

declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=30');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Base URL of your BirdNET-Go instance. No trailing slash.
// Override with the BIRDNET_GO_URL environment variable.
$BIRDNET_GO_URL = rtrim(
    getenv('BIRDNET_GO_URL') ?: 'https://birds.cellar.home',
    '/'
);

// Optional Basic Auth credentials if BirdNET-Go has auth enabled and this
// script is NOT on the local subnet (local subnet bypasses auth by default).
// Set via env vars to avoid baking secrets in source.
$BIRDNET_GO_USER = getenv('BIRDNET_GO_USER') ?: '';
$BIRDNET_GO_PASS = getenv('BIRDNET_GO_PASS') ?: '';

// HTTP timeout in seconds for each upstream request.
$HTTP_TIMEOUT = 10;

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

/**
 * Fetch a BirdNET-Go API endpoint and return decoded JSON (array), or null
 * on failure. $path must start with '/'.
 */
function bg_fetch(string $path, array $query = []): mixed {
  global $BIRDNET_GO_URL, $BIRDNET_GO_USER, $BIRDNET_GO_PASS, $HTTP_TIMEOUT;

  $url = $BIRDNET_GO_URL . $path;
  if ($query) {
    $url .= '?' . http_build_query($query);
  }

  $ctx_opts = [
    'http' => [
      'method'          => 'GET',
      'timeout'         => $HTTP_TIMEOUT,
      'ignore_errors'   => true,
      'follow_location' => 1,
      'header'          => ['Accept: application/json'],
    ],
    'ssl' => [
      'verify_peer'       => false,
      'verify_peer_name'  => false,
      'allow_self_signed' => true,
    ],
  ];

  if ($BIRDNET_GO_USER !== '') {
    $creds = base64_encode($BIRDNET_GO_USER . ':' . $BIRDNET_GO_PASS);
    $ctx_opts['http']['header'][] = 'Authorization: Basic ' . $creds;
  }

  $ctx  = stream_context_create($ctx_opts);
  $body = @file_get_contents($url, false, $ctx);

  if ($body === false) {
    return null;
  }

  $data = json_decode($body, true);
  return (json_last_error() === JSON_ERROR_NONE) ? $data : null;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/**
 * BirdNET-Go returns common_name / scientific_name; map to the original
 * facade's com/sci aliases so downstream code is uniform.
 */
function normalise_species(array $s): array {
    return [
        'sci'       => $s['scientific_name'] ?? $s['sci'] ?? '',
        'com'       => $s['common_name']     ?? $s['com'] ?? '',
        // pass through anything extra (species_code, hourly_counts, …)
    ] + $s;
}

/**
 * Format an ISO-8601 / RFC-3339 timestamp as "YYYY-MM-DD HH:MM:SS" to
 * match the original SQLite DATE||' '||TIME concatenation style.
 */
function fmt_dt(?string $iso): ?string {
    if ($iso === null || $iso === '') return null;
    try {
        $dt = new DateTimeImmutable($iso);
        return $dt->format('Y-m-d H:i:s');
    } catch (Throwable) {
        return $iso; // return as-is if we can't parse
    }
}

// ---------------------------------------------------------------------------
// Connectivity check
// ---------------------------------------------------------------------------

// Quick ping: fetch the summary endpoint; if it fails, return 503.
// (We skip this for actions that handle their own error responses.)

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

$action = $_GET['action'] ?? 'stats';

switch ($action) {

    // -----------------------------------------------------------------------
    case 'stats': {
      $summary = bg_fetch('/api/v2/analytics/species/summary');
      $daily = bg_fetch('/api/v2/analytics/species/daily');

      $last_hour_raw = bg_fetch('/api/v2/detections/recent', [
        'hours' => 1,
        'numResults' => 10000,
        'limit' => 10000,
      ]);

      $week_raw = bg_fetch('/api/v2/detections/recent', [
        'hours' => 168,
        'numResults' => 10000,
        'limit' => 10000,
      ]);

      if ($summary === null) {
        http_response_code(502);
        echo json_encode(['error' => 'upstream unavailable']);
        break;
      }

      $summary_list = is_array($summary)
        ? ($summary['species_list'] ?? $summary['species'] ?? (isset($summary[0]) ? $summary : []))
        : [];

      $daily_list = is_array($daily)
        ? ($daily['species_list'] ?? $daily['species'] ?? (isset($daily[0]) ? $daily : []))
        : [];

      $last_hour_list = is_array($last_hour_raw)
        ? ($last_hour_raw['detections'] ?? $last_hour_raw['data'] ?? $last_hour_raw['results'] ?? (isset($last_hour_raw[0]) ? $last_hour_raw : []))
        : [];

      $week_list = is_array($week_raw)
        ? ($week_raw['detections'] ?? $week_raw['data'] ?? $week_raw['results'] ?? (isset($week_raw[0]) ? $week_raw : []))
        : [];

      $total_species = count($summary_list);
      $today_species = count($daily_list);

      $total_detections = 0;
      foreach ($summary_list as $sp) {
        $total_detections += (int)($sp['count'] ?? $sp['total'] ?? 0);
      }

      $today_detections = 0;
      foreach ($daily_list as $sp) {
        $today_detections += (int)($sp['count'] ?? $sp['total'] ?? 0);
      }

      $last_hour_cutoff = new DateTimeImmutable('-1 hour');
      $week_cutoff = new DateTimeImmutable('-168 hours');

      $last_hour_det = 0;
      $last_hour_species_map = [];

      foreach ($last_hour_list as $d) {
        if (!is_array($d)) {
          continue;
        }

        $timestamp_raw = $d['timestamp']
          ?? $d['lastHeard']
          ?? $d['last_heard']
          ?? $d['lastSeen']
          ?? $d['last_seen']
          ?? null;

        if ($timestamp_raw === null) {
          continue;
        }

        try {
          $dt = new DateTimeImmutable($timestamp_raw);
        } catch (Throwable) {
          continue;
        }

        if ($dt < $last_hour_cutoff) {
          continue;
        }

        $last_hour_det++;

        $sci = $d['scientificName']
          ?? $d['scientific_name']
          ?? $d['sci']
          ?? '';

        $com = $d['commonName']
          ?? $d['common_name']
          ?? $d['com']
          ?? '';

        $key = $sci !== '' ? $sci : $com;

        if ($key !== '') {
          $last_hour_species_map[$key] = true;
        }
      }

      $week_det = 0;
      $week_species_map = [];

      foreach ($week_list as $d) {
        if (!is_array($d)) {
          continue;
        }

        $timestamp_raw = $d['timestamp']
          ?? $d['lastHeard']
          ?? $d['last_heard']
          ?? $d['lastSeen']
          ?? $d['last_seen']
          ?? null;

        if ($timestamp_raw === null) {
          continue;
        }

        try {
          $dt = new DateTimeImmutable($timestamp_raw);
        } catch (Throwable) {
          continue;
        }

        if ($dt < $week_cutoff) {
          continue;
        }

        $week_det++;

        $sci = $d['scientificName']
          ?? $d['scientific_name']
          ?? $d['sci']
          ?? '';

        $com = $d['commonName']
          ?? $d['common_name']
          ?? $d['com']
          ?? '';

        $key = $sci !== '' ? $sci : $com;

        if ($key !== '') {
          $week_species_map[$key] = true;
        }
      }

      $started = null;

      foreach ($summary_list as $sp) {
        if (!is_array($sp)) {
          continue;
        }

        $first_raw = $sp['firstHeard']
          ?? $sp['first_heard']
          ?? $sp['firstSeen']
          ?? $sp['first_seen']
          ?? null;

        $first_fmt = fmt_dt($first_raw);

        if ($first_fmt !== null && ($started === null || $first_fmt < $started)) {
          $started = $first_fmt;
        }
      }

      echo json_encode([
        'totals' => [
          'detections' => $total_detections,
          'species' => $total_species,
        ],
        'today' => [
          'detections' => $today_detections,
          'species' => $today_species,
        ],
        'last_hour' => [
          'detections' => $last_hour_det,
          'species' => count($last_hour_species_map),
        ],
        'week' => [
          'detections' => $week_det,
          'species' => count($week_species_map),
        ],
        'started' => $started,
        'as_of' => date('c'),
      ]);

      break;
    }
    // -----------------------------------------------------------------------
    case 'lifelist': {
        $summary = bg_fetch('/api/v2/analytics/species/summary');

        if ($summary === null) {
            http_response_code(502);
            echo json_encode(['error' => 'upstream unavailable']);
            break;
        }

        $list = is_array($summary) ? $summary : ($summary['species_list'] ?? []);

        $species = [];
        foreach ($list as $s) {
            $count = (int)($s['count'] ?? $s['total'] ?? 0);

            $species[] = [
              'sci'        => $s['scientificName'] ?? $s['scientific_name'] ?? '',
              'com'        => $s['commonName']     ?? $s['common_name']     ?? '',
              'first_seen' => fmt_dt($s['firstHeard'] ?? $s['first_heard'] ?? null),
              'last_seen'  => fmt_dt($s['lastHeard']  ?? $s['last_heard']  ?? null),
              'n'          => $count,
              'total'      => $count,
              'best_conf'  => isset($s['confidence']) ? (float)$s['confidence'] : null,
            ];
        }

        // Sort ascending by first_seen to match original query.
        usort($species, fn($a, $b) => strcmp((string)$a['first_seen'], (string)$b['first_seen']));

        echo json_encode(['species' => $species, 'as_of' => date('c')]);
        break;
      }

      // -----------------------------------------------------------------------
      case 'ebird_codes': {
        $summary = bg_fetch('/api/v2/analytics/species/summary');

        if ($summary === null) {
          http_response_code(502);
          echo json_encode(['error' => 'upstream unavailable']);
          break;
        }

        $list = is_array($summary) ? $summary : ($summary['species_list'] ?? $summary['species'] ?? []);

        $map = [];
        foreach ($list as $s) {
          if (!is_array($s)) continue;
          $sci = $s['scientificName'] ?? $s['scientific_name'] ?? $s['sci'] ?? '';
          $code = $s['speciesCode'] ?? $s['species_code'] ?? $s['species_code_ebird'] ?? null;
          if ($sci === '' || $code === null || $code === '') continue;
          $map[$sci] = $code;
        }

        echo json_encode($map);
        break;
      }

      // -----------------------------------------------------------------------
      case 'recent': {
      // Frontend period selector should call:
      //   1h  => ?action=recent&hours=1
      //   12h => ?action=recent&hours=12
      //   24h => ?action=recent&hours=24
      //   7d  => ?action=recent&hours=168
      //   all => ?action=recent&hours=1000000

      $hours = max(1, min(1000000, (int)($_GET['hours'] ?? 24)));
      $is_all = $hours >= 1000000;

      $species_map = [];

      // ---------------------------------------------------------------------
      // ALL mode:
      // Use species summary because it has true all-time counts.
      // ---------------------------------------------------------------------
      if ($is_all) {
        $summary = bg_fetch('/api/v2/analytics/species/summary');

        if ($summary === null) {
          http_response_code(502);
          echo json_encode(['error' => 'upstream unavailable']);
          break;
        }

        $list = is_array($summary)
          ? $summary
          : ($summary['species_list'] ?? $summary['species'] ?? []);

        foreach ($list as $s) {
          if (!is_array($s)) {
            continue;
          }

          $sci = $s['scientificName']
            ?? $s['scientific_name']
            ?? $s['sci']
            ?? '';

          $com = $s['commonName']
            ?? $s['common_name']
            ?? $s['com']
            ?? '';

          if ($sci === '' && $com === '') {
            continue;
          }

          $last_seen_raw = $s['lastHeard']
            ?? $s['last_heard']
            ?? $s['lastSeen']
            ?? $s['last_seen']
            ?? null;

          $first_seen_raw = $s['firstHeard']
            ?? $s['first_heard']
            ?? $s['firstSeen']
            ?? $s['first_seen']
            ?? null;

          $species_map[$sci !== '' ? $sci : $com] = [
            'sci'        => $sci,
            'com'        => $com,
            'n'          => (int)($s['count'] ?? $s['total'] ?? 0),
            'best_conf'  => isset($s['confidence']) ? (float)$s['confidence'] : null,
            'first_seen' => fmt_dt($first_seen_raw),
            'last_seen'  => fmt_dt($last_seen_raw),
            // recording.php and spectrogram.php can resolve by sci,
            // so top_file is not required for all-time summary rows.
            'top_file'   => null,
            'top_at'     => fmt_dt($last_seen_raw),
          ];
        }

        $species = array_values($species_map);

        usort($species, fn($a, $b) => strcmp(
          (string)$b['last_seen'],
          (string)$a['last_seen']
        ));

        echo json_encode([
          'hours'   => $hours,
          'period'  => 'all',
          'species' => $species,
          'as_of'   => date('c'),
        ]);

        break;
      }

      // ---------------------------------------------------------------------
      // Windowed mode:
      // 1h, 12h, 24h, 7d use /detections/recent and group detections locally.
      // ---------------------------------------------------------------------

      $raw = bg_fetch('/api/v2/detections/recent', [
        'hours'      => $hours,
        'numResults' => 10000,
        'limit'      => 10000,
      ]);

      if ($raw === null) {
        http_response_code(502);
        echo json_encode(['error' => 'upstream unavailable']);
        break;
      }

      $list = [];

      if (is_array($raw)) {
        $list = $raw['detections']
          ?? $raw['data']
          ?? $raw['results']
          ?? (isset($raw[0]) ? $raw : []);
      }

      $cutoff = new DateTimeImmutable("-{$hours} hours");

      foreach ($list as $d) {
        if (!is_array($d)) {
          continue;
        }

        $sci = $d['scientificName']
          ?? $d['scientific_name']
          ?? $d['sci']
          ?? '';

        $com = $d['commonName']
          ?? $d['common_name']
          ?? $d['com']
          ?? '';

        if ($sci === '' && $com === '') {
          continue;
        }

        $timestamp_raw = $d['timestamp']
          ?? $d['lastHeard']
          ?? $d['last_heard']
          ?? $d['lastSeen']
          ?? $d['last_seen']
          ?? null;

        if ($timestamp_raw === null) {
          continue;
        }

        try {
          $dt = new DateTimeImmutable($timestamp_raw);
        } catch (Throwable) {
          continue;
        }

        // Enforce the selected period locally even if BirdNET-Go returns more.
        if ($dt < $cutoff) {
          continue;
        }

        $key = $sci !== '' ? $sci : $com;
        $conf = isset($d['confidence']) ? (float)$d['confidence'] : null;
        $detection_id = isset($d['id']) ? (string)$d['id'] : null;
        $formatted_dt = fmt_dt($timestamp_raw);

        if (!isset($species_map[$key])) {
          $species_map[$key] = [
            'sci'        => $sci,
            'com'        => $com,
            'n'          => 0,
            'best_conf'  => null,
            'first_seen' => $formatted_dt,
            'last_seen'  => $formatted_dt,
            // Important: this is now the BirdNET-Go detection ID.
            // recording.php?file=<id> and spectrogram.php?file=<id> should work.
            'top_file'   => $detection_id,
            'top_at'     => $formatted_dt,
          ];
        }

        $species_map[$key]['n']++;

        if (
          $species_map[$key]['first_seen'] === null ||
          $formatted_dt < $species_map[$key]['first_seen']
        ) {
          $species_map[$key]['first_seen'] = $formatted_dt;
        }

        if (
          $species_map[$key]['last_seen'] === null ||
          $formatted_dt > $species_map[$key]['last_seen']
        ) {
          $species_map[$key]['last_seen'] = $formatted_dt;
        }

        if (
          $conf !== null &&
          (
            $species_map[$key]['best_conf'] === null ||
            $conf > $species_map[$key]['best_conf']
          )
        ) {
          $species_map[$key]['best_conf'] = $conf;
          $species_map[$key]['top_file'] = $detection_id;
          $species_map[$key]['top_at'] = $formatted_dt;
        }
      }

      $species = array_values($species_map);

      usort($species, fn($a, $b) => strcmp(
        (string)$b['last_seen'],
        (string)$a['last_seen']
      ));

      echo json_encode([
        'hours'   => $hours,
        'period'  => $hours . 'h',
        'species' => $species,
        'as_of'   => date('c'),
      ]);

      break;
    }
    // -----------------------------------------------------------------------
    case 'species': {
      $sci = trim($_GET['sci'] ?? '');

      if ($sci === '') {
        http_response_code(400);
        echo json_encode(['error' => 'sci= required']);
        break;
      }

      // Fetch detections for this species.
      $raw = bg_fetch('/api/v2/detections', [
        'species' => $sci,
        'numResults' => 500,
        'offset' => 0,
        'sort' => 'date_desc',
      ]);

      if ($raw === null) {
        // Fallback to recent/all and filter locally.
        $raw = bg_fetch('/api/v2/detections/recent', [
          'hours' => 1000000,
          'numResults' => 10000,
          'limit' => 10000,
        ]);
      }

      if ($raw === null) {
        http_response_code(502);
        echo json_encode(['error' => 'upstream unavailable']);
        break;
      }

      $det_list = [];

      if (is_array($raw)) {
        $det_list = $raw['detections']
          ?? $raw['data']
          ?? $raw['results']
          ?? (isset($raw[0]) ? $raw : []);
      }

      $detections = [];
      $first_seen = null;
      $last_seen = null;
      $best_conf = null;
      $com = '';
      $total = 0;

      foreach ($det_list as $d) {
        if (!is_array($d)) {
          continue;
        }

        $d_sci = $d['scientificName']
          ?? $d['scientific_name']
          ?? $d['sci']
          ?? '';

        // If the endpoint did not filter correctly, filter locally.
        if ($d_sci !== '' && strcasecmp($d_sci, $sci) !== 0) {
          continue;
        }

        $d_com = $d['commonName']
          ?? $d['common_name']
          ?? $d['com']
          ?? '';

        if ($com === '' && $d_com !== '') {
          $com = $d_com;
        }

        $timestamp_raw = $d['timestamp']
          ?? $d['lastHeard']
          ?? $d['last_heard']
          ?? $d['lastSeen']
          ?? $d['last_seen']
          ?? (($d['date'] ?? '') . ' ' . ($d['time'] ?? ''));

        $dt_str = fmt_dt($timestamp_raw);

        if ($dt_str === null || trim($dt_str) === '') {
          continue;
        }

        $conf = isset($d['confidence']) ? (float)$d['confidence'] : 0.0;

        $file = isset($d['id'])
          ? (string)$d['id']
          : (
            $d['clip_path']
            ?? $d['fileName']
            ?? $d['file_name']
            ?? $d['file']
            ?? null
          );

        $detections[] = [
          'd' => substr((string)$dt_str, 0, 10),
          't' => substr((string)$dt_str, 11, 8),
          // This is intentionally the BirdNET-Go detection ID when available.
          'file' => $file,
          'conf' => $conf,
        ];

        if ($best_conf === null || $conf > $best_conf) {
          $best_conf = $conf;
        }

        if ($first_seen === null || $dt_str < $first_seen) {
          $first_seen = $dt_str;
        }

        if ($last_seen === null || $dt_str > $last_seen) {
          $last_seen = $dt_str;
        }

        $total++;
      }

      // Prefer BirdNET-Go's total if present, but only if the endpoint
      // was actually filtered. Otherwise use the locally counted total.
      $reported_total = $raw['total']
        ?? $raw['count']
        ?? $total;

      $summary = [
        'com' => $com,
        'total' => (int)$reported_total,
        'first_seen' => $first_seen,
        'last_seen' => $last_seen,
        'best_conf' => $best_conf ?? 0,
      ];

      echo json_encode([
        'sci' => $sci,
        'summary' => $summary,
        'detections' => $detections,
      ]);

      break;
    }
    // -----------------------------------------------------------------------
    case 'timeseries': {
      // Frontend can call:
      //   1h  => ?action=timeseries&hours=1
      //   12h => ?action=timeseries&hours=12
      //   24h => ?action=timeseries&hours=24
      //   7d  => ?action=timeseries&hours=168
      //   all => ?action=timeseries&hours=1000000
      //
      // Backward-compatible:
      //   ?action=timeseries&days=30

      if (isset($_GET['hours'])) {
        $hours = max(1, min(1000000, (int)$_GET['hours']));
      } else {
        $days = max(1, min(3650, (int)($_GET['days'] ?? 30)));
        $hours = min(1000000, $days * 24);
      }

      $is_all = $hours >= 1000000;

      $raw = bg_fetch('/api/v2/detections/recent', [
        'hours' => $hours,
        'numResults' => 10000,
        'limit' => 10000,
      ]);

      if ($raw === null) {
        http_response_code(502);
        echo json_encode(['error' => 'upstream unavailable']);
        break;
      }

      $list = [];

      if (is_array($raw)) {
        $list = $raw['detections']
          ?? $raw['data']
          ?? $raw['results']
          ?? (isset($raw[0]) ? $raw : []);
      }

      $cutoff = $is_all ? null : new DateTimeImmutable("-{$hours} hours");

      $daily_map = [];
      $hourly_map = [];
      $species_daily_map = [];
      $species_seen_total = [];

      foreach ($list as $d) {
        if (!is_array($d)) {
          continue;
        }

        $timestamp_raw = $d['timestamp']
          ?? $d['lastHeard']
          ?? $d['last_heard']
          ?? $d['lastSeen']
          ?? $d['last_seen']
          ?? null;

        if ($timestamp_raw === null) {
          continue;
        }

        try {
          $dt = new DateTimeImmutable($timestamp_raw);
        } catch (Throwable) {
          continue;
        }

        if ($cutoff !== null && $dt < $cutoff) {
          continue;
        }

        $date = $dt->format('Y-m-d');
        $hour = (int)$dt->format('G');

        $sci = $d['scientificName']
          ?? $d['scientific_name']
          ?? $d['sci']
          ?? '';

        $com = $d['commonName']
          ?? $d['common_name']
          ?? $d['com']
          ?? '';

        $species_key = $sci !== '' ? $sci : $com;

        if (!isset($daily_map[$date])) {
          $daily_map[$date] = [
            'date' => $date,
            'detections' => 0,
            'species' => 0,
          ];
        }

        if (!isset($hourly_map[$hour])) {
          $hourly_map[$hour] = [
            'hour' => $hour,
            'detections' => 0,
          ];
        }

        $daily_map[$date]['detections']++;
        $hourly_map[$hour]['detections']++;

        if ($species_key !== '') {
          $species_seen_total[$species_key] = true;

          if (!isset($species_daily_map[$date])) {
            $species_daily_map[$date] = [];
          }

          $species_daily_map[$date][$species_key] = true;
        }
      }

      foreach ($daily_map as $date => $row) {
        $daily_map[$date]['species'] = isset($species_daily_map[$date])
          ? count($species_daily_map[$date])
          : 0;
      }

      ksort($daily_map);
      ksort($hourly_map);

      // Make sure by_hour always has 0-23 buckets, which makes charts stable.
      $by_hour_out = [];

      for ($h = 0; $h < 24; $h++) {
        $by_hour_out[] = [
          'hour' => $h,
          'detections' => $hourly_map[$h]['detections'] ?? 0,
        ];
      }

      echo json_encode([
        'hours' => $hours,
        'days' => (int)ceil($hours / 24),
        'period' => $is_all ? 'all' : $hours . 'h',
        'daily' => array_values($daily_map),
        'by_hour' => $by_hour_out,
        'species' => count($species_seen_total),
        'detections' => array_sum(array_column($daily_map, 'detections')),
        'as_of' => date('c'),
      ]);

      break;
    }

    // -----------------------------------------------------------------------
    case 'firstseen': {
        $limit = max(1, min(50, (int)($_GET['limit'] ?? 10)));

        $summary = bg_fetch('/api/v2/analytics/species/summary');

        if ($summary === null) {
            http_response_code(502);
            echo json_encode(['error' => 'upstream unavailable']);
            break;
        }

        $list = is_array($summary) ? $summary : ($summary['species_list'] ?? []);

        $species = [];
        foreach ($list as $s) {
            $species[] = [
                'sci'        => $s['scientific_name'] ?? '',
                'com'        => $s['common_name']     ?? '',
                'first_seen' => fmt_dt($s['first_heard'] ?? null),
                'total'      => (int)($s['count'] ?? 0),
            ];
        }

        // Sort descending by first_seen (most recent new arrivals first).
        usort($species, fn($a, $b) => strcmp((string)$b['first_seen'], (string)$a['first_seen']));

        $species = array_slice($species, 0, $limit);

        echo json_encode(['species' => $species, 'as_of' => date('c')]);
        break;
    }

    // -----------------------------------------------------------------------
    default:
        http_response_code(404);
        echo json_encode(['error' => 'unknown action']);
}