<?php
// AvianVisitors - bird image resolver.
//
// Lookup chain for /avian/api/cutout.php?sci=Calypte+anna:
//   pose=1: bundled perched illustration, then cutout/cache/Wikipedia fallback
//   pose=2: bundled flight illustration, then pose=1/cutout/cache/Wikipedia fallback
//   pose=3: Wikipedia photo, no rembg/cutout; returns the original photo directly
//
// Configure:
//   AV_USER_AGENT - optional User-Agent for Wikipedia requests

declare(strict_types=1);

$sci = trim((string)($_GET['sci'] ?? ''));

if ($sci === '') {
  http_response_code(400);
  echo 'sci required';
  exit;
}

if (!preg_match('/^[A-Za-z]{2,40}(?:[ ][a-z]{2,40}){1,3}$/', $sci)) {
  http_response_code(400);
  echo 'invalid sci';
  exit;
}

$slug = preg_replace('/[^a-z0-9]+/', '-', strtolower($sci));
$slug = trim((string)$slug, '-');

// pose=1 perched, pose=2 flight, pose=3 Wikipedia photo.
$pose = (int)($_GET['pose'] ?? 1);
if ($pose < 1 || $pose > 3) {
  $pose = 1;
}

$poseSuffix = $pose === 1 ? '' : "-$pose";

function av_http_context(): mixed {
  $ua = getenv('AV_USER_AGENT') ?: 'AvianVisitors/1.0';

  return stream_context_create([
    'http' => [
      'header' => "User-Agent: $ua\r\n",
      'timeout' => 12,
    ],
    'ssl' => [
      'verify_peer' => true,
      'verify_peer_name' => true,
    ],
  ]);
}

function av_debug_enabled(): bool {
  if (isset($_GET['debug']) || isset($_POST['debug'])) {
    return true;
  }
  $env = getenv('AV_DEBUG');
  if ($env !== false && in_array(strtolower($env), ['1', 'true', 'yes'], true)) {
    return true;
  }
  return false;
}

function wikipedia_image_url(string $sci): ?string {
  $ctx = av_http_context();
  $wpUrl = 'https://en.wikipedia.org/api/rest_v1/page/summary/' . rawurlencode($sci);
  $wpJson = @file_get_contents($wpUrl, false, $ctx);

  if ($wpJson === false) {
    if (av_debug_enabled()) {
      $hdrs = isset($http_response_header) ? implode("\n", $http_response_header) : '(no headers)';
      error_log("wikipedia summary fetch failed for {$sci}; url: {$wpUrl}; headers: {$hdrs}");
    } else {
      error_log("wikipedia summary fetch failed for {$sci}; url: {$wpUrl}");
    }
    return null;
  }

  $j = json_decode($wpJson, true);

  if (!is_array($j)) {
    if (av_debug_enabled()) {
      $err = json_last_error_msg();
      $snippet = substr((string)$wpJson, 0, 1024);
      error_log("wikipedia summary JSON decode failed for {$sci}: {$err}; payload: {$snippet}");
    } else {
      error_log("wikipedia summary JSON decode failed for {$sci}: " . json_last_error_msg());
    }
    return null;
  }

  $srcUrl = $j['originalimage']['source'] ?? $j['thumbnail']['source'] ?? null;

  if (!$srcUrl) {
    if (av_debug_enabled()) {
      $keys = implode(',', array_keys($j));
      $snippet = substr((string)$wpJson, 0, 1024);
      error_log("wikipedia summary has no image for {$sci}; keys: {$keys}; payload: {$snippet}");
    } else {
      error_log("wikipedia summary has no image for {$sci}");
    }
    return null;
  }

  $host = parse_url((string)$srcUrl, PHP_URL_HOST) ?: '';

  if (!preg_match('/(?:^|\.)(?:wikimedia\.org|wikipedia\.org)$/i', $host)) {
    if (av_debug_enabled()) {
      error_log("wikipedia image host not allowed for {$sci}: {$host}; url: {$srcUrl}");
    } else {
      error_log("wikipedia image host not allowed for {$sci}: {$host}");
    }
    return null;
  }

  return $srcUrl;
}

function content_type_from_url(string $url): string {
  $path = parse_url($url, PHP_URL_PATH) ?: '';
  $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));

  return match ($ext) {
    'jpg', 'jpeg' => 'image/jpeg',
    'png' => 'image/png',
    'webp' => 'image/webp',
    'gif' => 'image/gif',
    default => 'image/jpeg',
  };
}

// Note: we intentionally avoid caching the raw Wikipedia image or saving
// it as a non-pose-3 asset. The only persisted Wikipedia-derived asset
// created by this script is a pose-3 PNG via save_wikipedia_pose3().

function save_wikipedia_pose3(string $sci, string $imgBytes): ?string {
  $targetDir = dirname(__DIR__) . '/assets/illustrations-small';
  if (!is_dir($targetDir)) {
    @mkdir($targetDir, 0755, true);
  }

  $slug = preg_replace('/[^a-z0-9]+/', '-', strtolower($sci));
  $slug = trim((string)$slug, '-');

  $target = $targetDir . '/' . $slug . '-3.png';

  if (is_file($target) && filesize($target) > 1024) {
    return $target;
  }

  $im = @imagecreatefromstring($imgBytes);

  if ($im === false) {
    return null;
  }

  imagealphablending($im, false);
  imagesavealpha($im, true);

  $tmp = tempnam(sys_get_temp_dir(), 'avian-p3-');
  if ($tmp === false) {
    $tmp = sys_get_temp_dir() . '/avian-p3-' . uniqid();
  }

  $tmpOut = $tmp . '.png';
  imagepng($im, $tmpOut, 6);
  imagedestroy($im);

  if (is_file($tmpOut) && filesize($tmpOut) > 1024) {
    @rename($tmpOut, $target);
    @chmod($target, 0644);
    return $target;
  }

  @unlink($tmpOut);
  return null;
}

function serve_png(string $path): void {
  header('Content-Type: image/png');
  header('Cache-Control: public, max-age=86400');
  header('Content-Length: ' . (string)filesize($path));
  readfile($path);
  exit;
}

function serve_wikipedia_photo(string $sci): void {
  $srcUrl = wikipedia_image_url($sci);

  if (!$srcUrl) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    $msg = 'no Wikipedia photo for ' . htmlspecialchars($sci, ENT_QUOTES, 'UTF-8');
    error_log("no Wikipedia photo for {$sci}");
    if (av_debug_enabled()) {
      echo $msg . " (debug: see error log)";
    } else {
      echo $msg;
    }
    exit;
  }

  $ctx = av_http_context();
  $imgBytes = @file_get_contents($srcUrl, false, $ctx);

  if (!$imgBytes || strlen($imgBytes) < 1024) {
    $hdrs = isset($http_response_header) ? implode("\n", $http_response_header) : '(no headers)';
    $len = $imgBytes === false ? 'false' : (string)strlen($imgBytes);
    $logMsg = "failed to fetch Wikipedia photo for {$sci} from {$srcUrl}; bytes={$len}; headers={$hdrs}";
    error_log($logMsg);
    http_response_code(503);
    header('Content-Type: text/plain; charset=utf-8');
    if (av_debug_enabled()) {
      echo $logMsg;
    } else {
      echo 'failed to fetch Wikipedia photo';
    }
    exit;
  }

  // Save only as a pose-3 PNG; do not cache the raw Wikipedia image.
  @save_wikipedia_pose3($sci, $imgBytes);

  header('Content-Type: ' . content_type_from_url($srcUrl));
  header('Cache-Control: public, max-age=86400');
  header('Content-Length: ' . (string)strlen($imgBytes));
  echo $imgBytes;
  exit;
}

// ---------------------------------------------------------------------------
// pose=3: Wikipedia photo directly.
// ---------------------------------------------------------------------------

if ($pose === 3) {
  // Prefer a local pose-3 illustration if present.
  $localPose3 = dirname(__DIR__) . "/assets/illustrations-small/{$slug}-3.png";
  if (is_file($localPose3) && filesize($localPose3) > 1024) {
    serve_png($localPose3);
  }
  // No other local caches are used for pose=3; fetch from Wikipedia and
  // persist only a pose-3 PNG for future requests.
  serve_wikipedia_photo($sci);
}

// ---------------------------------------------------------------------------
// pose=1 / pose=2: existing illustration and cutout behavior.
// ---------------------------------------------------------------------------

// 1. Bundled illustration with pose suffix.
$bundled = dirname(__DIR__) . "/assets/illustrations-small/{$slug}{$poseSuffix}.png";

if (is_file($bundled) && filesize($bundled) > 1024) {
  serve_png($bundled);
}

// Pose-2 missing? Fall back to pose-1.
if ($pose !== 1) {
  $fallback = dirname(__DIR__) . "/assets/illustrations-small/$slug.png";

  if (is_file($fallback) && filesize($fallback) > 1024) {
    serve_png($fallback);
  }
}

// 2. Bundled cutout.
$cutout = dirname(__DIR__) . "/assets/cutouts/$slug.png";

if (is_file($cutout) && filesize($cutout) > 1024) {
  serve_png($cutout);
}

// 3. Dynamic cache from a previous Wikipedia + rembg run.
$cacheDir = dirname(__DIR__, 3) . '/BirdSongs/Extracted/cutouts';
$cachePath = "$cacheDir/$slug.png";

if (is_file($cachePath) && filesize($cachePath) > 1024) {
  serve_png($cachePath);
}

// Trigger background generation for missing illustrations (pose 1 / pose 2).
// We kick off api/genimg.php in the background and continue to the
// Wikipedia rembg fallback so the request remains fast.
if ($pose === 1 || $pose === 2) {
  $targetDir = dirname(__DIR__) . '/assets/illustrations-small';
  $t1 = $targetDir . '/' . $slug . '.png';
  $t2 = $targetDir . '/' . $slug . '-2.png';
  $need1 = !is_file($t1) || filesize($t1) < 1024;
  $need2 = !is_file($t2) || filesize($t2) < 1024;

  if ($need1 || ($pose !== 1 && $need2)) {
    $genScript = dirname(__DIR__) . '/api/genimg.php';
    if (is_file($genScript)) {
      $phpBin = defined('PHP_BINARY') ? PHP_BINARY : 'php';
      // If running under php-fpm, PHP_BINARY may point to php-fpm which
      // cannot be used to run scripts. Prefer the CLI `php` binary when
      // available.
      $phpBinCandidate = $phpBin;
      if (stripos(basename($phpBinCandidate), 'php-fpm') !== false || stripos(PHP_SAPI, 'fpm') !== false) {
        $resolved = null;
        if (function_exists('shell_exec')) {
          $which = trim(@shell_exec('command -v php 2>/dev/null') ?: '');
          if ($which) $resolved = $which;
        }
        if (!$resolved) {
          $candidates = ['/usr/bin/php', '/usr/local/bin/php', '/opt/homebrew/bin/php', '/usr/local/opt/php/bin/php'];
          foreach ($candidates as $c) {
            if (is_executable($c)) { $resolved = $c; break; }
          }
        }
        if ($resolved) {
          $phpBinCandidate = $resolved;
        } else {
          // fall back to plain 'php' (may or may not be available)
          $phpBinCandidate = 'php';
        }
      }
      $phpBin = $phpBinCandidate;
      // Forward common name if provided, and optional debug/log flags
      $comArg = trim((string)($_GET['com'] ?? $_POST['com'] ?? $sci));
      $cmdParts = [
        escapeshellarg($phpBin),
        escapeshellarg($genScript),
        escapeshellarg($sci),
        escapeshellarg($comArg),
      ];

      $isDebug = (isset($_GET['debug']) || isset($_POST['debug']));
      if ($isDebug) {
        $cmdParts[] = escapeshellarg('--debug');
      }

      if (isset($_GET['log']) && strlen((string)$_GET['log']) > 0) {
        $cmdParts[] = escapeshellarg('--log=' . (string)$_GET['log']);
      }

      $cmd = implode(' ', $cmdParts);

      if ($isDebug) {
        // Run synchronously and return output for debugging.
        header('Content-Type: text/plain; charset=utf-8');

        if (!function_exists('exec')) {
          echo "exec() is not available in this PHP build.\n";
          echo "disabled functions: " . ini_get('disable_functions') . "\n";
          exit;
        }

        $output = [];
        $rc = 0;
        exec($cmd . ' 2>&1', $output, $rc);
        echo "genimg command exited with code: $rc\n";
        echo "command: $cmd\n\n";
        echo implode("\n", $output);
        // Do not continue to Wikipedia/rembg fallback when debugging.
        exit;
      } else {
        // Spawn in background for normal requests.
        if (!function_exists('shell_exec')) {
          // Try fallback to exec for spawning background job.
          if (function_exists('exec')) {
            @exec($cmd . ' > /dev/null 2>&1 &');
          }
        } else {
          $bg = $cmd . ' > /dev/null 2>&1 &';
          @shell_exec($bg);
        }
      }
    }
  }
}

// 4. Fresh Wikipedia fetch + rembg.
$rembg = '/usr/local/bin/rembg-cli';

if (!is_executable($rembg)) {
  http_response_code(404);
  header('Content-Type: text/plain; charset=utf-8');
  echo 'no illustration bundled for ' . htmlspecialchars($sci, ENT_QUOTES, 'UTF-8') . ' (install rembg-cli to enable Wikipedia fallback)';
  exit;
}

if (!is_dir($cacheDir)) {
  @mkdir($cacheDir, 0755, true);
}

$srcUrl = wikipedia_image_url($sci);

if (!$srcUrl) {
  http_response_code(404);
  header('Content-Type: text/plain; charset=utf-8');
  echo 'no Wikipedia photo for ' . htmlspecialchars($sci, ENT_QUOTES, 'UTF-8');
  exit;
}

$ctx = av_http_context();
$imgBytes = @file_get_contents($srcUrl, false, $ctx);

if (!$imgBytes || strlen($imgBytes) < 1024) {
  http_response_code(503);
  header('Content-Type: text/plain; charset=utf-8');
  echo 'failed to fetch source image';
  exit;
}
// Save only as a pose-3 PNG; do not cache the raw Wikipedia image.
@save_wikipedia_pose3($sci, $imgBytes);

// rembg via the wrapper.
$tmpInBase = tempnam(sys_get_temp_dir(), 'rembg-in-');
$tmpOutBase = tempnam(sys_get_temp_dir(), 'rembg-out-');

@unlink($tmpInBase);
@unlink($tmpOutBase);

$tmpIn = $tmpInBase . '.jpg';
$tmpOut = $tmpOutBase . '.png';

file_put_contents($tmpIn, $imgBytes);

$cmd = sprintf(
  '%s i -m u2netp -ppm %s %s 2>&1',
  escapeshellarg($rembg),
  escapeshellarg($tmpIn),
  escapeshellarg($tmpOut)
);

$out = shell_exec($cmd);

@unlink($tmpIn);

if (!is_file($tmpOut) || filesize($tmpOut) < 1024) {
  @unlink($tmpOut);
  http_response_code(500);
  header('Content-Type: text/plain; charset=utf-8');
  echo "rembg failed (see your Pi's logs for details)";
  error_log("rembg failed for $sci: " . ($out ?? '(no output)'));
  exit;
}

// Tight-crop to the bird's bounding box + downscale to 800px max edge.
$im = @imagecreatefrompng($tmpOut);

if ($im !== false) {
  $cropped = @imagecropauto($im, IMG_CROP_TRANSPARENT);

  if ($cropped !== false) {
    imagedestroy($im);
    $im = $cropped;
  }

  $w = imagesx($im);
  $h = imagesy($im);
  $max = 800;

  if ($w > $max || $h > $max) {
    $scale = $max / max($w, $h);
    $nw = (int)($w * $scale);
    $nh = (int)($h * $scale);

    $resized = imagecreatetruecolor($nw, $nh);
    imagealphablending($resized, false);
    imagesavealpha($resized, true);
    imagecopyresampled($resized, $im, 0, 0, 0, 0, $nw, $nh, $w, $h);

    imagedestroy($im);
    $im = $resized;
  }

  imagealphablending($im, false);
  imagesavealpha($im, true);
  imagepng($im, $tmpOut, 6);
  imagedestroy($im);
}

@rename($tmpOut, $cachePath);
serve_png($cachePath);