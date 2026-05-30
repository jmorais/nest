(function () {
  var PLACEHOLDER = [{"sci":"Calypte anna","com":"Anna's Hummingbird","featured":true},{"sci":"Passer domesticus","com":"House Sparrow"},{"sci":"Haemorhous mexicanus","com":"House Finch"},{"sci":"Turdus migratorius","com":"American Robin"},{"sci":"Zenaida macroura","com":"Mourning Dove"},{"sci":"Spinus psaltria","com":"Lesser Goldfinch"},{"sci":"Zonotrichia leucophrys","com":"White-crowned Sparrow"},{"sci":"Aphelocoma californica","com":"California Scrub-Jay"},{"sci":"Mimus polyglottos","com":"Northern Mockingbird"},{"sci":"Sayornis nigricans","com":"Black Phoebe"},{"sci":"Larus occidentalis","com":"Western Gull"},{"sci":"Corvus brachyrhynchos","com":"American Crow"}];
  // Bumped whenever the offline sketch build changes, so the browser
  // doesn't keep a stale cache after we regenerate the sketches.
  var SKETCH_VERSION = '8'; // pose-2 strict re-audit: regenerated 8 flight
                            // illustrations that had phantom wing-shapes,
                            // training-image watermark, or ghosted partial
                            // wings (actitis, colaptes×2, meleagris,
                            // melospiza×2, progne, sitta, tachycineta).
  // Cache-bust for /api/img - bump whenever a bird gets re-rendered via
  // /api/regen or whenever you need every CF DC to drop its cached copy.
  // Cloudflare keys on the full URL incl. query, so bumping this is
  // equivalent to a global cache purge for /api/img. (caches.default
  // .delete() in the worker only affects ONE colo at a time, so a
  // versioned URL is the only reliable way to invalidate everywhere.)
  var IMG_VERSION = '4'; // re-regen of poecile-rufescens - prior version's
                          // wing-coverts read as a second/third wing alongside
                          // the chestnut back. New gen has clean separation.

  // ---- Sliding pill helper ----
  // Each segmented control has a single .seg-pill element that we move via
  // transform/width to whichever button currently has aria-current="true".
  // This gives an iOS-style smooth slide instead of a hard snap.
  function syncPill(container) {
    var pill = container.querySelector('.seg-pill');
    var active = container.querySelector('button[aria-current="true"]');
    if (!pill || !active) return;
    // offsetLeft is relative to the container (we set position:relative on it).
    pill.style.width = active.offsetWidth + 'px';
    pill.style.transform = 'translateX(' + active.offsetLeft + 'px)';
  }

  // ---- Slider ----
  var views = document.getElementById('views');
  var slider = document.getElementById('slider');
  var btns = [].slice.call(slider.querySelectorAll('button'));
  var winPick = document.getElementById('winPick');

  // Each view's title text. The shared static-head shows one of these
  // based on the current view; identical adjacent values mean the title
  // stays put with no fade (collage and stats both say Heard Recently).
  var VIEW_TITLES = ['Heard Recently', 'Heard Recently', 'Avian Visitors'];
  var staticHead = document.querySelector('.static-head');
  var staticTitle = document.getElementById('staticTitle');
  function setTitleForView(i) {
    var next = VIEW_TITLES[i];
    if (!staticTitle || staticTitle.textContent === next) return;
    // Fade out -> swap text -> fade in. The opacity transition is 240ms;
    // we swap at ~half that so the eye doesn't catch the text change.
    staticHead.classList.add('swap-out');
    setTimeout(function () {
      staticTitle.textContent = next;
      // Force reflow before removing class so the transition restarts.
      void staticHead.offsetWidth;
      staticHead.classList.remove('swap-out');
    }, 220);
  }

  function go(i) {
    i = Math.max(0, Math.min(2, i));
    views.style.transform = 'translateX(-' + (i * 100) + '%)';
    btns.forEach(function (b, j) { b.setAttribute('aria-current', j === i ? 'true' : 'false'); });
    syncPill(slider);
    setTitleForView(i);
  }
  btns.forEach(function (b) { b.addEventListener('click', function () { go(+b.dataset.i); }); });

  // ---- Window picker ----
  // Persist selections across reloads so a returning visitor lands on the
  // same view they left. Keys are namespaced so a future schema change
  // can be invalidated by bumping the prefix.
  function readLS(k, fallback) { try { return localStorage.getItem(k) || fallback; } catch (e) { return fallback; } }
  function writeLS(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  var winBtns = [].slice.call(winPick.querySelectorAll('button'));
  var currentHours = +readLS('bird:window', '24') || 24;
  winBtns.forEach(function (b) {
    b.setAttribute('aria-current', (+b.dataset.h === currentHours) ? 'true' : 'false');
  });
  winBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      winBtns.forEach(function (x) { x.setAttribute('aria-current', x === b ? 'true' : 'false'); });
      currentHours = +b.dataset.h;
      writeLS('bird:window', String(currentHours));
      syncPill(winPick);
      // Actual data refresh is wired below via refreshRecent().
    });
  });

  // Initial pill placement (after layout settles) + on resize.
  // Atlas sort segmented control - same pill-on-recess pattern.
  var atlasSortEl = document.getElementById('atlasSort');
  var atlasSortBtns = atlasSortEl ? [].slice.call(atlasSortEl.querySelectorAll('button')) : [];
  window.__atlasSort = readLS('bird:atlasSort', 'count');
  atlasSortBtns.forEach(function (b) {
    b.setAttribute('aria-current', (b.dataset.sort === window.__atlasSort) ? 'true' : 'false');
  });
  atlasSortBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      atlasSortBtns.forEach(function (x) { x.setAttribute('aria-current', x === b ? 'true' : 'false'); });
      window.__atlasSort = b.dataset.sort;
      writeLS('bird:atlasSort', window.__atlasSort);
      syncPill(atlasSortEl);
      // Re-render the atlas with new sort.
      renderAtlas();
    });
  });

  function syncAllPills() { syncPill(slider); syncPill(winPick); if (atlasSortEl) syncPill(atlasSortEl); }
  // The buttons size from text content; wait for fonts so width is correct.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(syncAllPills);
  }
  // Also sync after layout is definitely done.
  requestAnimationFrame(function () { requestAnimationFrame(syncAllPills); });
  var pillTimer;
  window.addEventListener('resize', function () {
    clearTimeout(pillTimer);
    pillTimer = setTimeout(syncAllPills, 80);
  });

  // ---- Raster-bitmask collage with bird-shaped nesting ----
  // Each species ships a low-res binary alpha mask (cutout_masks.ts) that
  // matches the bird's actual outline. The layout maintains an occupancy
  // grid at viewport resolution; for each tile we spiral outward from the
  // cluster centre and pick the closest position where the tile's mask
  // doesn't overlap any already-placed mask. Result: birds nest into each
  // other's concavities (wing arc cradles tail, etc.) with a small visual
  // gap baked into the mask via Python-side dilation. No bbox overlap, no
  // rectangles touching - actual polygon-aware packing.

  var collage = document.getElementById('collage');
  var DIMS = {};
  var MASKS = {};

  function loadStaticFiles() {
    var base = '';
    try {
      var s = document.currentScript && document.currentScript.src;
      if (s) base = s.replace(/[^\/]*$/, '');
    } catch (e) { base = ''; }
    function fetchJson(path) {
      return fetch(base + path, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); });
    }
    return Promise.all([
      fetchJson('dims.json').then(function (j) { DIMS = j; }),
      fetchJson('masks.json').then(function (j) { MASKS = j; }),
    ]);
  }

  // Tunables - Galliformes-poster-inspired. Raster-mask nesting.
  //
  // Layout discipline: tile areas are NORMALISED against a viewport
  // budget (sum of areas ≈ packingBudgetFrac × vpArea) rather than
  // each tile being clamped to a per-tile maxArea. The old per-tile
  // cap made every loud bird look identical (Anna n=398, Crow n=31
  // and Phoebe n=26 all hit ceiling and rendered the same size) AND
  // it allowed total area to overflow narrow viewports so birds got
  // dropped off-screen. Normalising fixes both - relative size
  // tracks the relative call ratio, and total area can never exceed
  // what the iterative shrink loop is willing to scale into the
  // viewport.
  function tuning(n, W, H) {
    var viewportAR = W / Math.max(1, H);
    var portrait = viewportAR < 0.82;

    var baseBudget =
      n <= 4  ? 1.56 :
      n <= 12 ? 1.40 :
      n <= 24 ? 1.20 :
                1.04;

    var baseMinArea =
      n <= 8  ? 0.0100 :
      n <= 20 ? 0.0075 :
                0.0055;

    return {
      packingBudgetFrac: baseBudget * (portrait ? 1.18 : 1),

      countExp: portrait ? 0.45 : 0.55, // area-from-count exponent; sublinear so big birds don't dwarf small ones

      minTileAreaFrac: baseMinArea * (portrait ? 1.05 : 1),

      // Desktop keeps the original wide poster composition.
      // Portrait deliberately becomes taller than wide.
      ellipseAspectBias: portrait ? 0.78 : 2.1,

      // Used by the portrait cost function to make vertical movement cheaper.
      verticalCostBias: portrait ? 0.58 : 1,

      // Extra portrait-only shaping.
      portrait: portrait,
      portraitXBias: 0.84,
      portraitYBias: 1.52
    };
  }

  var GRID_STRIDE = 4; // viewport px per occupancy cell; smaller = slower

  // Decode and cache each mask once. Sparse cell-list form (only "on"
  // cells) makes collision tests linear in opaque area, not total area.
  var maskCache = {};
  function loadMask(slug) {
    if (maskCache[slug]) return maskCache[slug];
    var rec = MASKS[slug];
    if (!rec) return null;
    var bytes = atob(rec.bits);
    var w = rec.w, h = rec.h;
    var cells = [];
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = y * w + x;
        var b = bytes.charCodeAt(i >> 3);
        if ((b >> (7 - (i & 7))) & 1) cells.push([x, y]);
      }
    }
    return (maskCache[slug] = { w: w, h: h, cells: cells });
  }

  function slugify(sci) {
    return sci.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  function aspect(sci) {
    var d = DIMS[slugify(sci)];
    return d ? d[0] / d[1] : 1.4;
  }

  // Mask-aware nester. tiles: { fullW, fullH, mask, data }. Returns the
  // same tiles with .x, .y assigned (top-left in viewport coords).
  function maskPack(tiles, W, H, T) {
    var ellipseBias = T.ellipseAspectBias;
    var portrait = !!T.portrait;

    var GW = Math.ceil(W / GRID_STRIDE) + 2;
    var GH = Math.ceil(H / GRID_STRIDE) + 2;
    var grid = new Uint8Array(GW * GH);

    function cellRange(tile, tx, ty, c) {
      // For mask cell (c[0], c[1]), return [gx0, gy0, gx1, gy1] (inclusive)
      // in grid coords, clamped to the grid.
      var sx = tile.fullW / tile.mask.w;
      var sy = tile.fullH / tile.mask.h;
      var x0 = (tx + c[0] * sx) / GRID_STRIDE | 0;
      var y0 = (ty + c[1] * sy) / GRID_STRIDE | 0;
      var x1 = (tx + (c[0] + 1) * sx) / GRID_STRIDE | 0;
      var y1 = (ty + (c[1] + 1) * sy) / GRID_STRIDE | 0;
      if (x0 < 0) x0 = 0;
      if (y0 < 0) y0 = 0;
      if (x1 >= GW) x1 = GW - 1;
      if (y1 >= GH) y1 = GH - 1;
      return [x0, y0, x1, y1];
    }

    function collides(tile, tx, ty) {
      var cells = tile.mask.cells;
      for (var i = 0; i < cells.length; i++) {
        var r = cellRange(tile, tx, ty, cells[i]);
        for (var gy = r[1]; gy <= r[3]; gy++) {
          var off = gy * GW;
          for (var gx = r[0]; gx <= r[2]; gx++) {
            if (grid[off + gx]) return true;
          }
        }
      }
      return false;
    }

    function stamp(tile, tx, ty) {
      var cells = tile.mask.cells;
      for (var i = 0; i < cells.length; i++) {
        var r = cellRange(tile, tx, ty, cells[i]);
        for (var gy = r[1]; gy <= r[3]; gy++) {
          var off = gy * GW;
          for (var gx = r[0]; gx <= r[2]; gx++) {
            grid[off + gx] = 1;
          }
        }
      }
    }

    function offGrid(tile, tx, ty) {
      // True if the rendered tile bbox extends past the viewport.
      return tx < 0 || ty < 0 || tx + tile.fullW > W || ty + tile.fullH > H;
    }

    var cx = W / 2;
    var cy = H / 2;

    // Largest first so the cluster grows around the anchor.
    tiles.sort(function (a, b) {
      return (b.fullW * b.fullH) - (a.fullW * a.fullH);
    });

    var placed = [];
    // Seeded PRNG keeps the layout stable across resizes.
    var seed = 0x9E3779B9;
    function rand() {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    }

    // Portrait target lanes make the plate grow up/down, not just outward
    // from a single center medallion.
    var portraitLanes = [
      { x: 0.50, y: 0.50 },
      { x: 0.50, y: 0.32 },
      { x: 0.50, y: 0.68 },

      { x: 0.36, y: 0.42 },
      { x: 0.64, y: 0.58 },
      { x: 0.36, y: 0.60 },
      { x: 0.64, y: 0.40 },

      { x: 0.28, y: 0.50 },
      { x: 0.72, y: 0.50 },

      { x: 0.50, y: 0.22 },
      { x: 0.50, y: 0.78 }
    ];

    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      var tx;
      var ty;

      if (i === 0) {
        tx = cx - t.fullW / 2;
        ty = cy - t.fullH / 2;
        t.x = tx;
        t.y = ty;
        stamp(t, tx, ty);
        placed.push(t);
        continue;
      }

      // Spiral outward. Stop the first ring that yields any non-colliding
      // position - that ring is the tightest possible distance from
      // centre. Within the ring, pick the position closest to the centre
      // of mass of already-placed tiles (so cluster grows organically,
      // not in fixed directions). On portrait/mobile this is modified
      // by target lanes and a vertical cost function so the result uses
      // more height.
      var comX = 0;
      var comY = 0;
      var comW = 0;

      placed.forEach(function (p) {
        if (p.x < -1000) return;
        var a = p.fullW * p.fullH;
        comX += (p.x + p.fullW / 2) * a;
        comY += (p.y + p.fullH / 2) * a;
        comW += a;
      });

      if (comW > 0) {
        comX /= comW;
        comY /= comW;
      } else {
        comX = cx;
        comY = cy;
      }

      var lane = portraitLanes[i % portraitLanes.length];
      var anchorX = portrait ? W * lane.x : cx;
      var anchorY = portrait ? H * lane.y : cy;

      var best = null;
      var bestCost = Infinity;
      var step = Math.max(GRID_STRIDE, Math.min(t.fullW, t.fullH) * 0.045);

      var xBias = portrait ? T.portraitXBias : ellipseBias;
      var yBias = portrait ? T.portraitYBias : 1;

      var maxR = Math.max(
        W / Math.max(0.35, xBias),
        H / Math.max(0.35, yBias)
      );

      var foundRing = -1;
      var phase = rand() * Math.PI * 2;

      for (var r = 0; r <= maxR; r += step) {
        if (foundRing >= 0 && r > foundRing + step * 3) break;

        var samples = Math.max(52, Math.floor(r / 1.15));

        for (var k = 0; k < samples; k++) {
          var theta = phase + (k / samples) * Math.PI * 2;

          var px = anchorX + r * xBias * Math.cos(theta) - t.fullW / 2;
          var py = anchorY + r * yBias * Math.sin(theta) - t.fullH / 2;

          if (offGrid(t, px, py)) continue;
          if (collides(t, px, py)) continue;

          var mx = px + t.fullW / 2;
          var my = py + t.fullH / 2;

          var dxx = mx - comX;
          var dyy = my - comY;

          var centerX = (mx - cx) / Math.max(1, W * 0.44);
          var centerY = (my - cy) / Math.max(1, H * 0.44);

          var anchorDX = (mx - anchorX) / Math.max(1, W * 0.38);
          var anchorDY = (my - anchorY) / Math.max(1, H * 0.38);

          var targetShapeCost = portrait
            ? Math.abs(centerX) * 34 + Math.abs(centerY) * 12
            : Math.abs(centerX) * 12 + Math.abs(centerY) * 18;

          var anchorCost = portrait
            ? Math.hypot(anchorDX * 18, anchorDY * 10)
            : 0;

          var comCost = portrait
            ? Math.hypot(dxx * 0.48, dyy * 0.34)
            : Math.hypot(dxx / ellipseBias, dyy);

          var edgeCost = portrait
            ? Math.max(0, Math.abs(centerX) - 0.84) * 85
            : 0;

          var cost = comCost + targetShapeCost + anchorCost + edgeCost + rand() * step * 0.5;

          if (cost < bestCost) {
            bestCost = cost;
            best = { x: px, y: py };
          }
        }

        if (best && foundRing < 0) foundRing = r;
      }

      if (best) {
        t.x = best.x;
        t.y = best.y;
        stamp(t, best.x, best.y);
        placed.push(t);
      } else {
        // Couldn't fit anywhere - hide off-screen rather than overlap.
        t.x = -99999;
        t.y = -99999;
        placed.push(t);
      }
    }

    return placed;
  }

  function renderCollage(items) {
    collage.innerHTML = '';
    if (!items.length) {
      collage.innerHTML = '<p class="empty">no birds heard in this window.</p>';
      return;
    }
    var W = collage.clientWidth;
    var H = collage.clientHeight;
    if (!W || !H) {
      setTimeout(function () {
        renderCollage(items);
      }, 80);
      return;
    }

    // Tuning depends on bird count and viewport aspect ratio - same
    // viewport, very different pack densities for 6 vs 48 birds. On
    // portrait/mobile it switches from a wide poster layout to a taller
    // specimen plate.
    var T = tuning(items.length, W, H);
    var vpArea = W * H;
    var budget = vpArea * T.packingBudgetFrac;
    var minArea = vpArea * T.minTileAreaFrac;

    // Step 1: build tiles + assign each a count-weighted SCORE (not a
    // final area yet). area-from-count uses a sub-linear exponent so
    // a 400-detection bird is visibly larger than a 30-detection bird
    // without dwarfing it.
    var tiles = items.map(function (s) {
      var slug = slugify(s.sci);
      var mask = loadMask(slug);
      if (!mask) return null;
      var n = +s.n;
      if (!n || isNaN(n)) n = 1;
      return {
        mask: mask,
        data: s,
        ar: aspect(s.sci),
        score: Math.pow(Math.max(1, n), T.countExp)
      };
    }).filter(Boolean);

    // Step 2: normalise so sum(area) ≈ budget. Then floor each tile
    // at minArea so even a 1-call bird stays legible.
    var sumScore = tiles.reduce(function (a, t) {
      return a + t.score;
    }, 0) || 1;

    tiles.forEach(function (t) {
      t.area = Math.max(minArea, budget * t.score / sumScore);
    });

    // After flooring, total may exceed budget; squeeze the over-budget
    // remainder out of the LARGER tiles (the ones above minArea) so
    // the floor on rare birds stays intact.
    var sumA = tiles.reduce(function (a, t) {
      return a + t.area;
    }, 0);

    if (sumA > budget) {
      var fixedSum = tiles.filter(function (t) {
        return t.area <= minArea + 1e-9;
      }).reduce(function (a, t) {
        return a + t.area;
      }, 0);

      var flexSum = sumA - fixedSum;
      var flexBudget = Math.max(0, budget - fixedSum);
      var shrink = flexSum > 0 ? Math.min(1, flexBudget / flexSum) : 1;

      tiles.forEach(function (t) {
        if (t.area > minArea + 1e-9) t.area *= shrink;
      });
    }

    // Step 3: derive width/height from area + per-species aspect.
    tiles.forEach(function (t) {
      t.fullW = Math.sqrt(t.area * t.ar);
      t.fullH = t.fullW / t.ar;
    });

    var placed = maskPack(tiles, W, H, T);

    // Scale-to-fit: iterate shrink + repack until every tile lands on
    // screen. The old single-pass version dropped birds when one pass
    // wasn't enough (narrow viewports + many species). Capped at 12
    // iterations - by then the linear scale is plenty small enough for
    // any viewport.
    function clusterBounds(arr) {
      var L = Infinity;
      var R = -Infinity;
      var T2 = Infinity;
      var B = -Infinity;
      arr.forEach(function (t) {
        if (t.x < -1000) return;
        if (t.x < L) L = t.x;
        if (t.x + t.fullW > R) R = t.x + t.fullW;
        if (t.y < T2) T2 = t.y;
        if (t.y + t.fullH > B) B = t.y + t.fullH;
      });
      return { L: L, R: R, T: T2, B: B };
    }

    var b = clusterBounds(placed);
    for (var iter = 0; iter < 12; iter++) {
      var missing = placed.some(function (t) {
        return t.x < -1000;
      });

      var overflow = b.L < 0 || b.T < 0 || b.R > W || b.B > H;

      if (!missing && !overflow) break;

      // Base 0.93 linear shrink (≈ 0.86 area). If overflow, take the
      // tighter of cluster-to-viewport ratios so we converge fast.
      var scale = 0.93;

      if (overflow) {
        var clW = b.R - b.L;
        var clH = b.B - b.T;
        var sx = (W * 0.96) / Math.max(clW, W * 0.96);
        var sy = (H * 0.97) / Math.max(clH, H * 0.97);
        scale = Math.min(scale, sx, sy);
      }

      tiles.forEach(function (t) {
        t.fullW *= scale;
        t.fullH *= scale;
      });

      placed = maskPack(tiles, W, H, T);
      b = clusterBounds(placed);
    }

    // Re-centre the cluster in the viewport so a small cluster doesn't
    // drift to one side from the spiral's center-of-mass bias.
    var dx = W / 2 - (b.L + b.R) / 2;
    var dy = H / 2 - (b.T + b.B) / 2;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      placed.forEach(function (t) {
        if (t.x > -1000) {
          t.x += dx;
          t.y += dy;
        }
      });
    }

    placed.forEach(function (r) {
      var s = r.data;
      // com flows through so the worker's JIT Gemini job uses the right
      // common name in its prompt for a freshly-detected species.
      // &v=IMG_VERSION busts CF edge cache when we re-render any species.
      var img = '/api/cutout.php?sci=' + encodeURIComponent(s.sci) +
        (s.com ? '&com=' + encodeURIComponent(s.com) : '') +
        '&v=' + IMG_VERSION;
      var btn = document.createElement('button');
      btn.className = 'gtile';
      btn.type = 'button';
      btn.setAttribute('data-sci', s.sci);
      btn.setAttribute('aria-label', s.com);
      // Fallback for keyboard / screen-reader users - the visible hover
      // pill below is the primary affordance for sighted mouse users.
      // "calls" (not "heard") because one bird can rack up dozens of
      // detections in a session; "heard" implies distinct individuals.
      var titleN = +s.n || 0;
      btn.title = (s.com || s.sci) + ' · ' + fmtN(titleN) + ' ' +
        (titleN === 1 ? 'call' : 'calls') + ' ' + windowLabel(currentHours);
      btn.style.left = r.x + 'px';
      btn.style.top = r.y + 'px';
      btn.style.width = r.fullW + 'px';
      btn.style.height = r.fullH + 'px';
      btn.innerHTML = '<img loading="lazy" decoding="async" src="' + img + '" alt="' + s.com + '">';
      r.el = btn;
      collage.appendChild(btn);
    });

    // Hover pill - created once per render so collage.innerHTML='' at
    // the top of this function doesn't strand a stale node. mousemove
    // populates its text from hit.data so the count is whatever the
    // current window's data says.
    var tip = document.createElement('div');
    tip.id = 'collageTip';
    tip.className = 'collage-tip';
    tip.setAttribute('aria-hidden', 'true');
    collage.appendChild(tip);
    // Stash the placed tiles so the alpha-mask hit-tester (below) can
    // resolve which silhouette the cursor is actually over.
    collagePlaced = placed.filter(function (t) {
      return t.x > -1000;
    });
  }

  // ---- Alpha-mask hover/click hit-testing ----
  // The .gtile buttons are rectangles and their bounding boxes overlap
  // (tight nesting). A plain :hover would light up whichever rectangle
  // is on top - often not the bird under the cursor. So we hit-test
  // the cursor against each tile's binary alpha mask and only the
  // genuinely-hit silhouette gets .is-hover / receives the click.
  var collagePlaced = [];
  var collageHovered = null;
  function maskHitTest(clientX, clientY) {
    var box = collage.getBoundingClientRect();
    var px = clientX - box.left, py = clientY - box.top;
    // Iterate topmost-first (later in DOM = painted on top).
    for (var i = collagePlaced.length - 1; i >= 0; i--) {
      var t = collagePlaced[i];
      if (px < t.x || py < t.y || px > t.x + t.fullW || py > t.y + t.fullH) continue;
      var mx = ((px - t.x) / t.fullW * t.mask.w) | 0;
      var my = ((py - t.y) / t.fullH * t.mask.h) | 0;
      // Build a fast lookup set once per mask.
      if (!t.mask._set) {
        var set = {};
        var cells = t.mask.cells;
        for (var c = 0; c < cells.length; c++) set[cells[c][0] + '|' + cells[c][1]] = 1;
        t.mask._set = set;
      }
      if (t.mask._set[mx + '|' + my]) return t;
    }
    return null;
  }
  collage.addEventListener('mousemove', function (ev) {
    var hit = maskHitTest(ev.clientX, ev.clientY);
    if (hit === collageHovered) return;
    if (collageHovered && collageHovered.el) collageHovered.el.classList.remove('is-hover');
    collageHovered = hit;
    if (hit && hit.el) hit.el.classList.add('is-hover');
    collage.style.cursor = hit ? 'pointer' : 'default';
    var tip = document.getElementById('collageTip');
    if (tip) {
      if (hit) {
        var s = hit.data;
        var n = +s.n || 0;
        var noun = (n === 1) ? 'call' : 'calls';
        tip.innerHTML = '<span class="ct-name">' + (s.com || s.sci) + '</span>'
          + '<span class="ct-w"> - </span>'
          + '<span class="ct-n">' + fmtN(n) + '</span>'
          + '<span class="ct-w"> ' + noun + ' ' + windowLabel(currentHours) + '</span>';
        tip.setAttribute('aria-hidden', 'false');
      } else {
        tip.setAttribute('aria-hidden', 'true');
      }
    }
  });
  collage.addEventListener('mouseleave', function () {
    if (collageHovered && collageHovered.el) collageHovered.el.classList.remove('is-hover');
    collageHovered = null;
    var tip = document.getElementById('collageTip');
    if (tip) tip.setAttribute('aria-hidden', 'true');
  });
  collage.addEventListener('click', function (ev) {
    var hit = maskHitTest(ev.clientX, ev.clientY);
    if (!hit) return;
    location.hash = '#sci=' + encodeURIComponent(hit.data.sci);
    go(2);
  });

  // Debug hook - call __layout({ slugs, weights, n }) from devtools to
  // re-render the collage with a custom item set. Lets us prove the
  // nester handles 6/12/24/48 birds and varied size hierarchies without
  // touching the source.
  window.__layout = function (opts) {
    opts = opts || {};
    var allSlugs = Object.keys({"acanthis-flammea":[560,372],"accipiter-cooperii":[558,560],"accipiter-gentilis":[558,560],"accipiter-striatus":[375,560],"actitis-macularius":[560,409],"aechmophorus-occidentalis":[525,560],"aegolius-acadicus":[560,558],"aeronautes-saxatalis":[560,439],"agelaius-phoeniceus":[276,560],"aix-sponsa":[560,378],"ammodramus-savannarum":[560,436],"amphispiza-bilineata":[560,559],"anas-crecca":[560,288],"anas-platyrhynchos":[558,560],"anser-albifrons":[560,439],"anthus-rubescens":[375,560],"aphelocoma-californica":[560,373],"aphelocoma-woodhouseii":[468,560],"aquila-chrysaetos":[437,560],"archilochus-alexandri":[560,344],"ardea-alba":[560,465],"ardea-herodias":[560,373],"artemisiospiza-belli":[560,435],"asio-flammeus":[560,560],"asio-otus":[404,560],"athene-cunicularia":[560,373],"aythya-affinis":[560,372],"aythya-americana":[560,553],"aythya-collaris":[560,373],"aythya-valisineria":[560,373],"baeolophus-inornatus":[560,311],"bombycilla-cedrorum":[339,560],"bombycilla-garrulus":[560,559],"branta-canadensis":[560,559],"bubo-virginianus":[373,560],"bubulcus-ibis":[267,560],"bucephala-albeola":[560,408],"bucephala-clangula":[560,242],"buteo-jamaicensis":[560,374],"buteo-lagopus":[560,244],"buteo-lineatus":[463,560],"buteo-regalis":[408,560],"buteo-swainsoni":[560,408],"butorides-virescens":[555,560],"calamospiza-melanocorys":[560,374],"calidris-alba":[560,371],"calidris-alpina":[560,374],"callipepla-californica":[560,372],"calothorax-lucifer":[465,560],"calypte-anna":[560,344],"calypte-costae":[560,409],"cardellina-pusilla":[560,281],"cardellina-rubrifrons":[527,560],"cathartes-aura":[376,560],"catharus-guttatus":[560,333],"catharus-ustulatus":[560,408],"catherpes-mexicanus":[320,560],"certhia-americana":[201,560],"chaetura-vauxi":[560,374],"charadrius-vociferus":[560,408],"chondestes-grammacus":[560,559],"chordeiles-minor":[560,319],"cinclus-mexicanus":[560,465],"circus-hudsonius":[372,560],"cistothorus-palustris":[437,560],"coccothraustes-vespertinus":[560,466],"colaptes-auratus":[560,560],"columba-livia":[560,327],"columbina-passerina":[560,559],"contopus-sordidulus":[560,502],"coragyps-atratus":[560,557],"corvus-brachyrhynchos":[560,503],"corvus-corax":[343,560],"cyanocitta-stelleri":[363,560],"cygnus-buccinator":[560,370],"cypseloides-niger":[560,356],"dryobates-nuttallii":[560,321],"dryobates-pubescens":[560,558],"dryobates-villosus":[268,560],"dryocopus-pileatus":[492,560],"egretta-caerulea":[560,321],"egretta-thula":[560,374],"elanus-leucurus":[560,378],"empidonax-difficilis":[268,560],"empidonax-hammondii":[558,560],"empidonax-oberholseri":[495,560],"empidonax-traillii":[371,560],"empidonax-wrightii":[560,527],"eremophila-alpestris":[560,529],"euphagus-cyanocephalus":[560,371],"falco-columbarius":[560,408],"falco-mexicanus":[349,560],"falco-peregrinus":[465,560],"falco-sparverius":[560,370],"gavia-immer":[560,374],"geothlypis-tolmiei":[560,406],"geothlypis-trichas":[560,316],"glaucidium-gnoma":[560,560],"gymnogyps-californianus":[466,560],"haemorhous-mexicanus":[523,560],"haemorhous-purpureus":[560,387],"haliaeetus-leucocephalus":[560,434],"himantopus-mexicanus":[458,560],"hirundo-rustica":[560,410],"hydroprogne-caspia":[560,373],"icteria-virens":[560,293],"icterus-bullockii":[560,214],"icterus-cucullatus":[391,560],"icterus-galbula":[560,528],"icterus-parisorum":[560,266],"ixoreus-naevius":[560,558],"junco-hyemalis":[560,320],"lanius-ludovicianus":[408,560],"larus-californicus":[560,437],"larus-delawarensis":[560,376],"larus-glaucescens":[560,374],"larus-heermanni":[560,436],"larus-occidentalis":[560,412],"leiothlypis-celata":[522,560],"leiothlypis-lucidae":[351,560],"leucophaeus-atricilla":[560,373],"leucophaeus-pipixcan":[560,560],"leucosticte-tephrocotis":[560,465],"limosa-fedoa":[560,556],"lophodytes-cucullatus":[560,409],"loxia-curvirostra":[560,319],"mareca-americana":[560,375],"mareca-strepera":[560,372],"megaceryle-alcyon":[560,409],"megascops-kennicottii":[560,374],"melanerpes-formicivorus":[351,560],"melanerpes-lewis":[372,560],"meleagris-gallopavo":[560,373],"melospiza-georgiana":[320,560],"melospiza-lincolnii":[560,245],"melospiza-melodia":[560,352],"melozone-aberti":[560,268],"melozone-crissalis":[560,538],"melozone-fusca":[560,495],"mergus-merganser":[560,374],"mimus-polyglottos":[560,310],"mniotilta-varia":[560,351],"molothrus-ater":[560,505],"myadestes-townsendi":[560,436],"myiarchus-cinerascens":[560,532],"nucifraga-columbiana":[560,373],"numenius-americanus":[558,560],"nycticorax-nycticorax":[560,465],"oreothlypis-ruficapilla":[372,560],"pandion-haliaetus":[560,371],"passer-domesticus":[560,444],"passerculus-sandwichensis":[560,542],"passerella-iliaca":[560,350],"passerina-amoena":[560,465],"passerina-cyanea":[560,560],"patagioenas-fasciata":[560,500],"pelecanus-erythrorhynchos":[560,316],"pelecanus-occidentalis":[560,406],"perisoreus-canadensis":[560,349],"petrochelidon-pyrrhonota":[558,560],"phainopepla-nitens":[560,464],"phalacrocorax-auritus":[490,560],"phalaenoptilus-nuttallii":[560,373],"phasianus-colchicus":[560,409],"pheucticus-melanocephalus":[559,560],"pica-nuttalli":[560,320],"picoides-arcticus":[374,560],"pinicola-enucleator":[560,372],"pipilo-chlorurus":[560,318],"pipilo-erythrophthalmus":[352,560],"pipilo-maculatus":[443,560],"piranga-ludoviciana":[293,560],"piranga-rubra":[560,495],"plegadis-chihi":[560,372],"podiceps-nigricollis":[560,374],"podilymbus-podiceps":[560,374],"poecile-gambeli":[560,350],"poecile-rufescens":[560,339],"polioptila-caerulea":[560,557],"pooecetes-gramineus":[560,436],"progne-subis":[313,560],"psaltriparus-minimus":[560,428],"quiscalus-mexicanus":[560,269],"recurvirostra-americana":[268,560],"regulus-calendula":[496,560],"regulus-satrapa":[464,560],"riparia-riparia":[560,494],"rynchops-niger":[560,374],"salpinctes-obsoletus":[560,465],"sayornis-nigricans":[308,560],"sayornis-saya":[463,560],"selasphorus-platycercus":[560,497],"selasphorus-rufus":[560,436],"selasphorus-sasin":[434,560],"setophaga-coronata":[461,560],"setophaga-magnolia":[560,268],"setophaga-nigrescens":[560,350],"setophaga-occidentalis":[560,367],"setophaga-palmarum":[438,560],"setophaga-petechia":[560,268],"setophaga-ruticilla":[560,293],"setophaga-townsendi":[560,416],"sialia-currucoides":[558,560],"sialia-mexicana":[560,371],"sitta-canadensis":[560,379],"sitta-carolinensis":[436,560],"sitta-pygmaea":[560,407],"spatula-clypeata":[560,408],"spatula-discors":[560,493],"sphyrapicus-ruber":[560,558],"sphyrapicus-thyroideus":[374,560],"spinus-lawrencei":[560,373],"spinus-pinus":[560,516],"spinus-psaltria":[560,548],"spinus-tristis":[536,560],"spizella-atrogularis":[246,560],"spizella-breweri":[560,557],"spizella-passerina":[560,320],"spizelloides-arborea":[560,436],"stelgidopteryx-serripennis":[558,560],"sterna-forsteri":[560,373],"sterna-hirundo":[560,411],"streptopelia-decaocto":[560,393],"strix-occidentalis":[560,553],"sturnella-neglecta":[320,560],"sturnus-vulgaris":[560,545],"tachycineta-bicolor":[375,560],"tachycineta-thalassina":[560,435],"thalasseus-elegans":[560,407],"thryomanes-bewickii":[560,263],"toxostoma-redivivum":[560,298],"tringa-semipalmata":[560,464],"troglodytes-aedon":[560,494],"troglodytes-pacificus":[560,407],"turdus-migratorius":[560,402],"tyrannus-verticalis":[559,560],"tyrannus-vociferans":[495,560],"tyto-alba":[560,464],"urile-penicillatus":[296,560],"vireo-bellii":[560,559],"vireo-cassinii":[560,319],"vireo-gilvus":[464,560],"vireo-huttoni":[410,560],"xanthocephalus-xanthocephalus":[293,560],"zenaida-asiatica":[560,558],"zenaida-macroura":[522,560],"zonotrichia-atricapilla":[560,238],"zonotrichia-leucophrys":[560,313],"zonotrichia-querula":[560,294]});
    allSlugs = Object.keys(DIMS || {});
    var slugs = opts.slugs || allSlugs.slice(0, opts.n || 12);
    var weights = opts.weights;
    var items = slugs.map(function (slug, i) {
      // Recover a sci name from the slug - capitalize first segment.
      var parts = slug.split('-');
      var sci = parts.slice(0, 2).map(function (p, j) { return j === 0 ? p[0].toUpperCase() + p.slice(1) : p; }).join(' ');
      var n;
      if (weights === 'uniform') n = 10;
      else if (weights === 'extreme') n = i === 0 ? 500 : 1;
      else if (Array.isArray(weights)) n = weights[i] || 1;
      else n = Math.pow(0.55, i) * 100; // default hierarchy
      return { sci: sci, com: sci, n: n };
    });
    renderCollage(items);
    return { rendered: items.length, mode: weights || 'hierarchy' };
  };

  // Collage renders whatever is in DATA.recent.species. When the picker
  // changes, refreshRecent() refetches and re-renders. Empty state shows
  // a "no detections in this window" message.
  function renderCollageFromData() {
    var items = (DATA.recent && DATA.recent.species) || [];
    renderCollage(items);
  }
  var rTimer;
  window.addEventListener('resize', function () {
    clearTimeout(rTimer);
    rTimer = setTimeout(function () {
      renderCollageFromData();
      drawHistograms();
    }, 120);
  });

  // ---- Stats / Atlas data ----
  function setRow(id, label, val) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = '<span>' + label + '</span><span>' + (val == null || val === '' ? '-' : val) + '</span>';
  }
  function liRow(yr, label, ct, sci) {
    var attr = sci ? ' data-sci="' + sci.replace(/"/g, '&quot;') + '"' : '';
    return '<li' + attr + '><span class="yr">' + yr + '</span><span>' + label + '</span><span class="ct">' + (ct == null ? '-' : ct) + '</span></li>';
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtN(n) {
    if (n == null) return '-';
    if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
    return n.toLocaleString();
  }
  // Human label for the current time-window picker selection - replaces
  // a bare "window" with the span it actually covers. Thresholds match
  // the winPick buttons (1H / 12H / 24H / 7D / ALL).
  function windowLabel(h) {
    if (h <= 1) return 'this hour';
    if (h <= 12) return 'past 12h';
    if (h <= 24) return 'today';
    if (h <= 168) return 'this week';
    return 'all time';
  }

  // ---- Live Pi data layer ----
  // All views read from this DATA object. Populated by fetchAll() on page
  // load and by refreshRecent() when the window picker changes.
  var STATS_DAYS = 30;
  var DATA = {
    stats: null,        // /api/birdnet-api.php?action=stats (totals/today/week/last_hour/started)
    lifelist: null,     // /api/birdnet-api.php?action=lifelist (every species ever detected)
    timeseries: null,   // /api/birdnet-api.php?action=timeseries (daily + hourly aggregates)
    firstseen: null,    // /api/birdnet-api.php?action=firstseen (newest lifelist additions)
    recent: null,       // /api/birdnet-api.php?action=recent&hours=N (refetched on picker change)
  };

  // Derived chart arrays, backfilled so 30 buckets always exist.
  var STATS = {
    detPerDay:  new Array(STATS_DAYS).fill(0), // [day] total detections
    specPerDay: new Array(STATS_DAYS).fill(0), // [day] unique species
    byHour:     new Array(24).fill(0),         // [hour-of-day] detections
  };

  // Map sci -> all-time detection count, populated from lifelist for atlas.
  var speciesTotals = {};

  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); });
  }

  function backfillDaily(daily, days) {
    // Build a continuous array of (days) length, ending today.
    var byDate = {};
    (daily || []).forEach(function (row) { byDate[row.date] = row; });
    var out = new Array(days).fill(null).map(function () { return { detections: 0, species: 0 }; });
    var today = new Date();
    for (var i = 0; i < days; i++) {
      var d = new Date(today);
      d.setDate(today.getDate() - (days - 1 - i));
      var key = d.toISOString().slice(0, 10);
      if (byDate[key]) {
        out[i].detections = +byDate[key].detections || 0;
        out[i].species    = +byDate[key].species    || 0;
      }
    }
    return out;
  }

  function recomputeDerived() {
    var ts = DATA.timeseries || { daily: [], by_hour: [] };
    var ll = DATA.lifelist || { species: [] };
    var rows = backfillDaily(ts.daily, STATS_DAYS);
    STATS.detPerDay  = rows.map(function (r) { return r.detections; });
    STATS.specPerDay = rows.map(function (r) { return r.species; });
    var byHour = new Array(24).fill(0);
    (ts.by_hour || []).forEach(function (r) { byHour[+r.hour] = +r.detections; });
    STATS.byHour = byHour;
    speciesTotals = {};
    (ll.species || []).forEach(function (s) { speciesTotals[s.sci] = +s.total; });
  }

  // ---- Chart palette ----
  // Monochromatic ink, matching the title text (--ink). Bars positioned
  // toward the "recent" end of the gradient render in deeper ink; older
  // bars fade to a warm light grey. Same hue family throughout.
  function barColor(t) {
    // t = 0 (outer / newest) -> 1 (inner / oldest).
    // Monochromatic ink palette: same warm hue as the title text
    // (--ink: #1a1612 ≈ HSL 25, 14%, 9%). Newest hours render in deep
    // ink so the outer perimeter reads bold; older hours fade to a
    // warm light grey, the chart looks like a hand-pulled engraving.
    var hue = 25;                    // warm-grey hue, matches --ink family
    var sat = 12 - t * 8;             // 12% -> 4%
    var light = 14 + t * 50;          // 14% (near-black) -> 64% (light grey)
    return 'hsl(' + hue + ', ' + sat.toFixed(0) + '%, ' + light.toFixed(0) + '%)';
  }

  // Editorial detection timeline. One column per species; the black
  // square's height up the column encodes detection count (y axis),
  // columns run left->right oldest->newest detection (x axis). A
  // rotated species label sits just above each square. Y-axis count
  // ticks on the left, X-axis time labels on the bottom. Always fits
  // the viewport - column widths flex, square size steps down as the
  // species count climbs.
  function drawHistograms() {
    var tl = document.getElementById('statsTimeline');
    if (!tl) return;
    var all = ((DATA.recent && DATA.recent.species) || []).slice();

    // X-axis = the FULL selected time window, so quiet stretches show
    // as actual empty space. windowStart/now span everything; species
    // squares get placed within by their last_seen timestamp.
    var now = Date.now();
    var isAllWindow = currentHours >= 1000000;
    var windowStart;
    if (isAllWindow) {
      // ALL = since the earliest known first_seen. Fall back to 'now'
      // if the firstseen list hasn't loaded yet, which collapses to an
      // empty span - the empty-state branch below catches that.
      var oldest = now;
      var first = (DATA.firstseen && DATA.firstseen.species) || [];
      first.forEach(function (s) {
        var t = Date.parse((s.first_seen || '').replace(' ', 'T'));
        if (!isNaN(t) && t < oldest) oldest = t;
      });
      ((DATA.lifelist && DATA.lifelist.species) || []).forEach(function (s) {
        var t = Date.parse((s.first_seen || '').replace(' ', 'T'));
        if (!isNaN(t) && t < oldest) oldest = t;
      });
      windowStart = oldest;
    } else {
      windowStart = now - currentHours * 3600000;
    }
    var windowSpan = Math.max(1, now - windowStart);

    if (!all.length) {
      tl.innerHTML = '<div class="stats-tl-empty">no detections in this window</div>';
      return;
    }

    // Cap species count so labels don't pile up. Same rule as before -
    // ~28 px per visible mark - but applied to the count of marks, not
    // the column layout (which is now time-positioned).
    var plotW = Math.max(140, (tl.clientWidth || window.innerWidth || 800) - 40);
    var cap = Math.max(4, Math.floor(plotW / 28));
    var trimmed = all.length > cap;
    var species = all.slice();
    if (trimmed) {
      species.sort(function (a, b) { return (+b.n || 0) - (+a.n || 0); });
      species = species.slice(0, cap);
    }

    var maxN = species.reduce(function (m, s) { return Math.max(m, +s.n || 0); }, 1);
    var C = species.length;
    var tier = C <= 5 ? 24 : C <= 12 ? 18 : C <= 24 ? 13 : 9;
    var sq = Math.max(7, Math.min(tier, Math.round((plotW / C) * 0.62)));
    var LABEL_GAP = 7;
    var SPAN = 0.52; // bottom slice of plot for squares; rest is label headroom.

    // Y-axis: 0..maxN with maxN pinned on the top tick. Same as before.
    var ticks = [];
    if (maxN <= 8) {
      for (var v = 0; v <= maxN; v++) ticks.push(v);
    } else {
      var divs = 4;
      for (var i = 0; i <= divs; i++) ticks.push(Math.round(maxN * i / divs));
      ticks[ticks.length - 1] = maxN;
    }
    var yaxis = ticks.map(function (v) {
      var pct = (v / maxN) * SPAN * 100;
      return '<span class="stats-tl-ytick" style="bottom:' + pct.toFixed(1) + '%">' + v + '</span>';
    }).join('');

    // Marks - each species placed by its last_seen time on the x-axis.
    function parseTs(s) {
      if (!s) return NaN;
      return Date.parse(s.replace(' ', 'T'));
    }
    var cols = species.map(function (s) {
      var ts = parseTs(s.last_seen);
      var leftPct;
      if (isNaN(ts)) {
        leftPct = 50;
      } else {
        var clamped = Math.max(windowStart, Math.min(now, ts));
        leftPct = ((clamped - windowStart) / windowSpan) * 100;
      }
      var n = +s.n || 0;
      var bottomPct = (n / maxN) * SPAN * 100;
      return ''
        + '<div class="stats-tl-col" data-sci="' + s.sci + '" style="left:' + leftPct.toFixed(2) + '%">'
        +   '<div class="stats-tl-square" style="bottom:' + bottomPct.toFixed(1) + '%;width:' + sq + 'px;height:' + sq + 'px"></div>'
        +   '<div class="stats-tl-label" style="bottom:calc(' + bottomPct.toFixed(1) + '% + ' + (sq + LABEL_GAP) + 'px)">'
        +     '<span class="com">' + (s.com || s.sci) + '</span>'
        +     '<span class="sci">' + s.sci + '</span>'
        +   '</div>'
        + '</div>';
    }).join('');

    // X-axis ticks + gridlines at regular boundaries that span the
    // window - every 15 min for 1H, every 4-6 h for 24H, every day for
    // 7D, etc. Both are children of the plot so left:% aligns.
    function pickStepMs(span) {
      var h = span / 3600000;
      if (h <= 1.2) return 15 * 60000;
      if (h <= 6) return 60 * 60000;
      if (h <= 14) return 2 * 3600000;
      if (h <= 36) return 6 * 3600000;
      if (h <= 9 * 24) return 24 * 3600000;
      if (h <= 75 * 24) return 7 * 24 * 3600000;
      return 30 * 24 * 3600000;
    }
    function fmtTick(ms, span) {
      var d = new Date(ms);
      var p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
      if (span <= 36 * 3600000) return p2(d.getHours()) + ':' + p2(d.getMinutes());
      if (span <= 75 * 86400000) return (d.getMonth() + 1) + '/' + d.getDate();
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    var stepMs = pickStepMs(windowSpan);
    var firstTick = Math.ceil(windowStart / stepMs) * stepMs;
    var xaxis = '', gridlines = '';
    for (var t = firstTick; t <= now; t += stepMs) {
      var pct = ((t - windowStart) / windowSpan) * 100;
      xaxis += '<span class="stats-tl-xtick" style="left:' + pct.toFixed(2) + '%">' + fmtTick(t, windowSpan) + '</span>';
      gridlines += '<i class="stats-tl-gridline" style="left:' + pct.toFixed(2) + '%"></i>';
    }

    var note = trimmed
      ? '<div class="stats-tl-cap">' + C + ' most-heard of ' + all.length + '</div>'
      : '';
    tl.innerHTML =
      '<div class="stats-tl-yaxis">' + yaxis + '</div>'
      + '<div class="stats-tl-plot">' + gridlines + cols + xaxis + '</div>'
      + note;
  }

  // Cross-highlight between the timeline squares and the right-side
  // species lists. Delegated off the stats view so it survives the
  // periodic re-render of both halves.
  (function wireStatsHighlight() {
    var v1 = document.getElementById('v1');
    if (!v1) return;
    function setHi(sci, on) {
      if (!sci) return;
      var esc = sci.replace(/"/g, '\"');
      v1.querySelectorAll('.stats-tl-col[data-sci="' + esc + '"], .stats-side li[data-sci="' + esc + '"]')
        .forEach(function (el) { el.classList.toggle('sync-hi', on); });
    }
    v1.addEventListener('mouseover', function (ev) {
      var el = ev.target.closest && ev.target.closest('[data-sci]');
      if (el) setHi(el.getAttribute('data-sci'), true);
    });
    v1.addEventListener('mouseout', function (ev) {
      var el = ev.target.closest && ev.target.closest('[data-sci]');
      if (el) {
        // Only clear if we're actually leaving the element (not moving
        // to a child).
        var to = ev.relatedTarget;
        if (to && el.contains(to)) return;
        setHi(el.getAttribute('data-sci'), false);
      }
    });
  })();

  // ---- Side text lists (real Pi data) ----
  function renderStatsLists() {
    var stats = DATA.stats || {};
    var recent = DATA.recent || { species: [] };
    var firstseen = DATA.firstseen || { species: [] };

    // By Period - pulled directly from /api/birdnet-api.php?action=stats so the numbers
    // are authoritative (BirdNET-Pi's own counts).
    var last_hour = (stats.last_hour && stats.last_hour.detections) || 0;
    var today_det = (stats.today && stats.today.detections) || 0;
    var week_det = (stats.week && stats.week.detections) || 0;
    var all_det = (stats.totals && stats.totals.detections) || 0;
    document.getElementById('statsByPeriod').innerHTML =
        liRow('NOW',   'last hour',   fmtN(last_hour))
      + liRow('TODAY', 'today',       fmtN(today_det))
      + liRow('WEEK',  'last 7 days', fmtN(week_det))
      + liRow('ALL',   'all time',    fmtN(all_det));

    // Top Species - top 5 species in the current window. /api/birdnet-api.php?action=recent
    // already returns species sorted by last_seen DESC; re-sort by count.
    var ranked = (recent.species || [])
      .slice()
      .sort(function (a, b) { return (+b.n) - (+a.n); })
      .slice(0, 5);
    document.getElementById('statsTopSpec').innerHTML = ranked.length
      ? ranked.map(function (s, i) { return liRow(pad(i + 1), s.com, fmtN(+s.n), s.sci); }).join('')
      : liRow('-', 'no detections in window', '');
    document.getElementById('statsTopSpecCap').textContent =
      'most-heard, ' + windowLabel(currentHours);

    // First Detections - newest additions to the life list, with a
    // "Xd ago" label computed from first_seen.
    var fs = (firstseen.species || []).slice(0, 5);
    var now = Date.now();
    document.getElementById('statsFirstSeen').innerHTML = fs.length
      ? fs.map(function (s) {
          var t = Date.parse((s.first_seen || '').replace(' ', 'T'));
          var label = '-';
          if (!isNaN(t)) {
            var daysAgo = Math.floor((now - t) / 86400000);
            label = daysAgo === 0 ? 'today' : daysAgo + 'd ago';
          }
          return liRow(label, s.com, '', s.sci);
        }).join('')
      : liRow('-', 'no detections yet', '');
  }

  // ---- Atlas: field-guide card grid ----
  // eBird species codes for placeholder birds. eBird's URL scheme is
  // https://ebird.org/species/<code>/, where <code> is a stable 6-char
  // taxonomy code. Hardcoded here for the local-California demo set;
  // a real implementation can look these up via the eBird taxon API.
  var EBIRD_CODES = {};

  // Populate EBIRD_CODES from the backend mapping (sci -> ebird species_code).
  // This uses the birdnet-api facade which proxies BirdNET-Go's
  // /api/v2/analytics/species/summary and returns a compact mapping.
  fetchJson('/api/birdnet-api.php?action=ebird_codes')
    .then(function (j) {
      if (j && typeof j === 'object') EBIRD_CODES = j;
    })
    .catch(function (e) { console.warn('ebird_codes fetch failed', e); });

  function wikiUrl(sci) {
    return 'https://en.wikipedia.org/wiki/' + encodeURIComponent(sci.replace(/ /g, '_'));
  }
  function ebirdUrl(sci) {
    var code = EBIRD_CODES[sci];
    return code ? 'https://ebird.org/species/' + code : 'https://ebird.org/explore';
  }

  // Tiny inline icons - monochrome, ink-only, match the page palette.
  var ICON_PLAY = '<svg viewBox="0 0 12 12" fill="currentColor"><path d="M3 2 L10 6 L3 10 Z"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 12 12" fill="currentColor"><rect x="3" y="2" width="2.5" height="8"/><rect x="6.5" y="2" width="2.5" height="8"/></svg>';

  function renderAtlas() {
    var grid = document.getElementById('atlasGrid');
    if (!grid) return;

    var lifelist = (DATA.lifelist && DATA.lifelist.species) || [];
    var recent = (DATA.recent && DATA.recent.species) || [];
    // Window count lookup: sci -> count in current window.
    var winBySci = {};
    recent.forEach(function (s) { winBySci[s.sci] = +s.n; });

    if (!lifelist.length) {
      grid.innerHTML = '<div class="atlas-empty">' +
        '<p>No birds detected yet.</p>' +
        '<p class="hint">The atlas fills up as BirdNET-Pi identifies new species.</p>' +
        '</div>';
      return;
    }

    // Time-window filter: when a windowed view is selected, only show
    // species heard in that window. ALL preserves the full lifelist.
    var isAllWindow = currentHours >= 1000000;
    var filtered = isAllWindow
      ? lifelist
      : lifelist.filter(function (s) { return (winBySci[s.sci] || 0) > 0; });
    if (!filtered.length) {
      grid.innerHTML = '<div class="atlas-empty">' +
        '<p>No detections in this window.</p>' +
        '<p class="hint">Try a longer time window - the lifelist is still here under ALL.</p>' +
        '</div>';
      return;
    }

    // Sort by the atlas-sort segmented control (defaults to "count" =
    // most-heard all time).
    var sortMode = (window.__atlasSort) || 'count';
    var species = filtered.slice();
    if (sortMode === 'count') {
      species.sort(function (a, b) { return (+b.total) - (+a.total); });
    } else if (sortMode === 'recent') {
      species.sort(function (a, b) {
        return (b.last_seen || '').localeCompare(a.last_seen || '');
      });
    } else if (sortMode === 'alpha') {
      species.sort(function (a, b) {
        return (a.com || a.sci || '').localeCompare(b.com || b.sci || '');
      });
    }

    grid.innerHTML = species.map(function (s) {
      var total = +s.total || 0;
      var win = winBySci[s.sci] || 0;
      var sketchSrc = '/api/cutout.php?sci=' + encodeURIComponent(s.sci) +
        (s.com ? '&com=' + encodeURIComponent(s.com) : '') +
        '&v=' + SKETCH_VERSION;
      var audioSrc = '/api/recording.php?sci=' + encodeURIComponent(s.sci);
      var spectroSrc = '/api/spectrogram.php?sci=' + encodeURIComponent(s.sci);
      // The "all time" window makes the windowed count identical to the
      // all-time count - collapse to a single stat rather than print the
      // same number twice. Otherwise label the count with its span.
      var statRows = currentHours >= 1000000
        ? '<div><span class="n">' + fmtN(total) + '</span><span class="lbl-inline">all time</span></div>'
        : '<div><span class="n">' + fmtN(win) + '</span><span class="lbl-inline">' + windowLabel(currentHours) + '</span></div>'
          + '<div><span class="n">' + fmtN(total) + '</span><span class="lbl-inline">all time</span></div>';
      return ''
        + '<article class="bird-card" data-sci="' + s.sci + '" data-audio="' + audioSrc + '" data-spectro="' + spectroSrc + '">'
        +   '<div class="stat">' + statRows + '</div>'
        +   '<div class="img-wrap">'
        +     '<img loading="lazy" decoding="async" src="' + sketchSrc + '" alt="' + s.com + '">'
        +   '</div>'
        +   '<div class="spectro-wrap" aria-hidden="true"></div>'
        +   '<h3>' + s.com + '</h3>'
        +   '<div class="sci">' + s.sci + '</div>'
        +   '<div class="actions">'
        +     '<button type="button" class="chip play" data-action="play" aria-label="play recording">'
        +       ICON_PLAY + '<span>play</span>'
        +     '</button>'
        +     '<a class="chip ext" href="' + wikiUrl(s.sci) + '" target="_blank" rel="noopener" aria-label="Wikipedia">wiki</a>'
        +     '<a class="chip ext" href="' + ebirdUrl(s.sci) + '" target="_blank" rel="noopener" aria-label="eBird">ebird</a>'
        +   '</div>'
        + '</article>';
    }).join('');

    // Wire audio playback + spectrogram load.
    // - Only one card plays at a time. Clicking play on a different card
    //   stops the current one first.
    // - The spectrogram is lazily fetched on first play (saves a Pi hit
    //   for every card visible on initial render).
    // - If the recording endpoint 404s (no detection yet for this
    //   species), the button reverts and shows "no audio".
    var currentAudio = null;
    var currentBtn = null;
    function setBtnState(btn, state) {
      btn.setAttribute('data-state', state);
      if (state === 'playing') {
        btn.setAttribute('data-active', 'true');
        btn.innerHTML = ICON_PAUSE + '<span>stop</span>';
      } else if (state === 'loading') {
        btn.setAttribute('data-active', 'true');
        btn.innerHTML = ICON_PLAY + '<span>...</span>';
      } else if (state === 'missing') {
        btn.setAttribute('data-active', 'false');
        btn.innerHTML = ICON_PLAY + '<span>no audio</span>';
        setTimeout(function () {
          if (btn.getAttribute('data-state') === 'missing') {
            btn.innerHTML = ICON_PLAY + '<span>play</span>';
            btn.setAttribute('data-state', 'idle');
          }
        }, 2200);
      } else {
        btn.setAttribute('data-active', 'false');
        btn.innerHTML = ICON_PLAY + '<span>play</span>';
      }
    }
    function clearProgressOn(card) {
      if (!card) return;
      var sw = card.querySelector('.spectro-wrap');
      if (sw) sw.style.setProperty('--prog', '0%');
      card.removeAttribute('data-playing');
    }
    function stopCurrent() {
      if (currentAudio) {
        try { currentAudio.pause(); } catch (e) {}
        currentAudio = null;
      }
      if (currentBtn) {
        var card = currentBtn.closest('.bird-card');
        clearProgressOn(card);
        setBtnState(currentBtn, 'idle');
        currentBtn = null;
      }
    }
    grid.querySelectorAll('[data-action="play"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var card = btn.closest('.bird-card');
        if (btn === currentBtn) { stopCurrent(); return; }
        stopCurrent();
        setBtnState(btn, 'loading');
        currentBtn = btn;
        // Kick off spectrogram load in parallel (it's a separate request).
        var spectroWrap = card.querySelector('.spectro-wrap');
        if (spectroWrap && !spectroWrap.firstChild) {
          var img = document.createElement('img');
          img.loading = 'lazy';
          img.alt = '';
          img.src = card.dataset.spectro;
          img.addEventListener('error', function () { spectroWrap.removeChild(img); });
          spectroWrap.appendChild(img);
        }
        // Start audio.
        var audio = new Audio(card.dataset.audio);
        audio.addEventListener('canplay', function () {
          if (currentBtn !== btn) return; // user clicked away
          setBtnState(btn, 'playing');
          card.setAttribute('data-playing', 'true');
          audio.play();
        });
        // Progress bar on the spectrogram strip.
        audio.addEventListener('timeupdate', function () {
          if (currentBtn !== btn) return;
          var pct = audio.duration ? (audio.currentTime / audio.duration * 100) : 0;
          if (spectroWrap) spectroWrap.style.setProperty('--prog', pct.toFixed(1) + '%');
        });
        audio.addEventListener('ended', function () {
          if (currentBtn === btn) stopCurrent();
        });
        audio.addEventListener('error', function () {
          if (currentBtn === btn) {
            setBtnState(btn, 'missing');
            clearProgressOn(card);
            currentAudio = null; currentBtn = null;
          }
        });
        currentAudio = audio;
        audio.load();
      });
    });

    // Spectrogram click = scrub to that position (if playing) or restart.
    grid.addEventListener('click', function (ev) {
      var sw = ev.target.closest && ev.target.closest('.spectro-wrap');
      if (!sw || !sw.firstChild) return;
      var card = sw.closest('.bird-card');
      var btn = card.querySelector('[data-action="play"]');
      // If this card is the active one, scrub.
      if (currentBtn === btn && currentAudio && currentAudio.duration) {
        var rect = sw.getBoundingClientRect();
        var pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
        currentAudio.currentTime = pct * currentAudio.duration;
      } else {
        // Otherwise start playback from the top.
        btn.click();
      }
    });
  }

  function renderWindowDependent() {
    // Things that change with the time-window picker. drawHistograms is
    // here too now that its X-axis spans the selected window (was only
    // re-drawn on full refreshAll before).
    renderCollageFromData();
    drawHistograms();
    renderStatsLists();
    renderAtlas();
  }
  function renderTimeIndependent() {
    // Stats charts + atlas/stats lists that derive from non-window data
    // (totals, lifelist, timeseries).
    drawHistograms();
    renderStatsLists();
    renderAtlas();
  }

  function refreshRecent() {
    // Capture the window this fetch was issued for. If the user
    // changes the picker again before it resolves - or a slower poll
    // lands later - we discard the stale response so the collage
    // never reverts to a different window.
    var forHours = currentHours;
    return fetchJson('/api/birdnet-api.php?action=recent&hours=' + forHours)
      .then(function (j) {
        if (forHours !== currentHours) return; // window changed mid-flight
        DATA.recent = j; renderWindowDependent();
      })
      .catch(function (e) { console.warn('recent fetch failed', e); });
  }
  function refreshAll() {
    var forHours = currentHours;
    return Promise.all([
      fetchJson('/api/birdnet-api.php?action=stats').catch(function () { return null; }),
      fetchJson('/api/birdnet-api.php?action=lifelist').catch(function () { return null; }),
      fetchJson('/api/birdnet-api.php?action=timeseries&days=30').catch(function () { return null; }),
      fetchJson('/api/birdnet-api.php?action=firstseen&limit=10').catch(function () { return null; }),
      fetchJson('/api/birdnet-api.php?action=recent&hours=' + forHours).catch(function () { return null; }),
    ]).then(function (parts) {
      DATA.stats = parts[0];
      DATA.lifelist = parts[1];
      DATA.timeseries = parts[2];
      DATA.firstseen = parts[3];
      // Only accept the recent slice if the window hasn't changed
      // since this poll started - otherwise keep what's there.
      if (forHours === currentHours && parts[4]) DATA.recent = parts[4];
      recomputeDerived();
      renderTimeIndependent();
      renderCollageFromData();
    });
  }

  // Kick off the initial fetch. Renders pull from DATA as soon as it
  // populates; until then the page sits with empty histograms + lists.
  loadStaticFiles().catch(function (e) { console.warn('failed to load dims/masks', e); }).then(function () { refreshAll(); });

  // Hook into the window picker so the data refetches on change.
  winBtns.forEach(function (b) {
    b.addEventListener('click', function () { refreshRecent(); });
  });

  // ---- Realtime polling ----
  // Every POLL_MS the page refetches the live data set so the collage,
  // stats, and atlas reflect new detections without a manual reload.
  // We use refreshAll() (cheap: 5 small JSON fetches) so the dependent
  // text/charts update too. Polling pauses when the tab is hidden and
  // resumes (with an immediate fetch) when it becomes visible again.
  var POLL_MS = 30 * 1000;
  var pollTimer = null;
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(function () {
      if (document.hidden) return;
      refreshAll();
    }, POLL_MS);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopPolling();
    } else {
      // Force an immediate refresh on return so the user sees fresh
      // data right away, then resume normal polling cadence.
      refreshAll();
      startPolling();
    }
  });
  startPolling();

  // ---- Hash routing + atlas detail modal ----
  // When a collage tile or stats row is clicked it sets
  // location.hash = '#sci=<name>'. On arrival we switch to the atlas
  // view, highlight the matching card, AND open the detail modal with
  // expanded info (Wikipedia summary, taxonomy, all past recordings).
  function readHash() {
    var m = location.hash.match(/^#sci=([^&]+)/);
    if (!m) return null;
    return decodeURIComponent(m[1]);
  }
  function highlightAtlas(sci) {
    var grid = document.getElementById('atlasGrid');
    if (!grid) return;
    grid.querySelectorAll('.bird-card[data-active="true"]').forEach(function (c) {
      c.removeAttribute('data-active');
    });
    if (!sci) return;
    var attempts = 0;
    (function find() {
      var card = grid.querySelector('.bird-card[data-sci="' + sci.replace(/"/g, '\"') + '"]');
      if (!card) {
        if (attempts++ < 10) return setTimeout(find, 80);
        return;
      }
      card.setAttribute('data-active', 'true');
      card.setAttribute('data-pulse', 'true');
      setTimeout(function () { card.removeAttribute('data-pulse'); }, 520);
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    })();
  }

  // ---- Detail modal ----
  // Caches per-sci species info so opening the same modal twice doesn't
  // re-fetch. Wikipedia + per-species endpoints are slow over the
  // tunnel; one fetch per session is plenty.
var SPECIES_CACHE = {};
var WIKI_CACHE = {};
var modalAudio = null;
var modalRecBtn = null;
var modalCloseTimer = null;

  function fmtRecTime(d, t) {
    // d="2026-05-15", t="20:25:29"
    if (!d) return '-';
    var date = new Date((d || '') + 'T' + (t || '00:00:00'));
    if (isNaN(date.getTime())) return d + ' ' + (t || '');
    var now = Date.now();
    var ago = Math.floor((now - date.getTime()) / 1000);
    if (ago < 60) return ago + 's ago';
    if (ago < 3600) return Math.floor(ago / 60) + 'm ago';
    if (ago < 86400) return Math.floor(ago / 3600) + 'h ago';
    return Math.floor(ago / 86400) + 'd ago';
  }
  function fmtDateLine(d, t) {
    if (!d) return '';
    try {
      var date = new Date(d + 'T' + (t || '00:00:00'));
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
        ' · ' + (t ? t.slice(0, 5) : '');
    } catch (e) { return d + ' ' + (t || ''); }
  }
  function rarityLabel(total, firstSeenIso) {
    if (!total) return '-';
    var days = 1;
    if (firstSeenIso) {
      var t = Date.parse((firstSeenIso || '').replace(' ', 'T'));
      if (!isNaN(t)) days = Math.max(1, Math.ceil((Date.now() - t) / 86400000));
    }
    var perDay = total / days;
    if (perDay >= 5) return 'common';
    if (perDay >= 1) return 'regular';
    if (perDay >= 0.2) return 'occasional';
    return 'rare';
  }
  // rAF-driven cursor smoothing. timeupdate fires ~4Hz which feels
  // janky; we sample audio.currentTime every animation frame and
  // interpolate to a 60Hz update so the playback knob glides.
  var modalCursorRaf = null;
  function startCursorLoop() {
    if (modalCursorRaf) return;
    var tick = function () {
      if (!modalAudio || !modalRecBtn) { modalCursorRaf = null; return; }
      var row = modalRecBtn.closest('.rec-row');
      if (row && modalAudio.duration) {
        var strip = row.querySelector('.rec-spectro');
        var played = strip && strip.querySelector('.rec-spectro-played');
        var cursor = strip && strip.querySelector('.rec-spectro-cursor');
        var pct = (modalAudio.currentTime / modalAudio.duration) * 100;
        if (played) played.style.width = pct.toFixed(3) + '%';
        if (cursor) cursor.style.left = pct.toFixed(3) + '%';
      }
      modalCursorRaf = requestAnimationFrame(tick);
    };
    modalCursorRaf = requestAnimationFrame(tick);
  }
  function stopCursorLoop() {
    if (modalCursorRaf) { cancelAnimationFrame(modalCursorRaf); modalCursorRaf = null; }
  }

  // Pause the currently-playing modal recording but KEEP the audio
  // element alive so the user can scrub (audio.currentTime is still
  // mutable on a paused element) and then resume from the same spot.
  // The cursor stays visible at its last position.
  function pauseModalAudio() {
    stopCursorLoop();
    if (modalAudio) { try { modalAudio.pause(); } catch (e) {} }
    if (modalRecBtn) {
      modalRecBtn.removeAttribute('data-active');
      modalRecBtn.innerHTML = ICON_PLAY;
    }
  }
  // Hard-stop: pause + tear down the audio + clear cursor. Used when
  // switching rows or closing the modal.
  function stopModalAudio() {
    stopCursorLoop();
    if (modalAudio) { try { modalAudio.pause(); } catch (e) {} modalAudio = null; }
    if (modalRecBtn) {
      var prevRow = modalRecBtn.closest('.rec-row');
      if (prevRow) {
        var strip = prevRow.querySelector('.rec-spectro');
        if (strip) {
          strip.classList.remove('armed');
          var played = strip.querySelector('.rec-spectro-played');
          var cur = strip.querySelector('.rec-spectro-cursor');
          if (played) played.style.width = '0%';
          if (cur) cur.style.left = '0%';
        }
      }
      modalRecBtn.removeAttribute('data-active');
      modalRecBtn.innerHTML = ICON_PLAY;
      modalRecBtn = null;
    }
  }

  function sketchSrc(sci, pose) {
    // Look up the common name from the lifelist so the worker's JIT
    // Gemini prompt is right for a never-pre-rendered species.
    var sp = ((DATA.lifelist && DATA.lifelist.species) || [])
      .find(function (s) { return s.sci === sci; });
    var com = sp ? (sp.com || '') : '';
    var base = '/api/cutout.php?sci=' + encodeURIComponent(sci) +
      (com ? '&com=' + encodeURIComponent(com) : '') +
      '&v=' + SKETCH_VERSION;
    var n = +pose || 1;
    return n > 1 ? base + '&pose=' + n : base;
  }
  function openDetailModal(sci) {
    if (!sci) return;
    
    var modal = document.getElementById('detail-modal');

    if (modalCloseTimer) {
      clearTimeout(modalCloseTimer);
      modalCloseTimer = null;
    }

    modal.classList.remove('is-closing');

    var img = document.getElementById('modalImg');
    var poseToggle = document.getElementById('modalPoseToggle');
    var poseBtns = [].slice.call(poseToggle.querySelectorAll('button'));

    // Reset the toggle: assume nothing's available, set pose 1 (perched
    // cutout - every species has it) as the optimistic default. HEAD
    // probes below toggle each button on/off and pick the best default.
    poseToggle.removeAttribute('data-unavailable');
    poseBtns.forEach(function (b) {
      b.setAttribute('data-unavailable', 'true');
      b.setAttribute('aria-current', 'false');
    });
    var p1 = poseToggle.querySelector('button[data-pose="1"]');
    if (p1) {
      p1.removeAttribute('data-unavailable');
      p1.setAttribute('aria-current', 'true');
    }
    img.src = sketchSrc(sci, 1);
    img.alt = sci;

    // Probe only local/generated illustration poses. Do NOT probe pose=3
    // here because pose=3 fetches the Wikipedia photo. It should only
    // load after the user explicitly clicks the photo button.
    var probes = poseBtns
      .filter(function (b) {
        return +b.dataset.pose !== 3;
      })
      .map(function (b) {
        var pose = +b.dataset.pose;
        return fetch(sketchSrc(sci, pose), { method: 'HEAD', cache: 'no-store' })
          .then(function (r) { return { pose: pose, btn: b, ok: r.ok }; })
          .catch(function () { return { pose: pose, btn: b, ok: false }; });
      });

    Promise.all(probes).then(function (results) {
      var p3 = poseToggle.querySelector('button[data-pose="3"]');
      var available = results.filter(function (r) { return r.ok; });

      available.forEach(function (r) { r.btn.removeAttribute('data-unavailable'); });
      results.filter(function (r) { return !r.ok; }).forEach(function (r) {
        r.btn.setAttribute('data-unavailable', 'true');
      });

      // Pose 3 is always allowed as a lazy, click-only Wikipedia photo.
      // Mark it available without HEAD-probing it, otherwise the modal
      // would trigger a Wikipedia request before the user asks for it.
      if (p3) {
        p3.removeAttribute('data-unavailable');
      }

      // Default only to local/generated poses. Prefer pose 2 if available,
      // otherwise pose 1. Never auto-select pose 3.
      var pick = available.sort(function (a, b) { return b.pose - a.pose; })[0];
      if (pick) {
        poseBtns.forEach(function (b) {
          b.setAttribute('aria-current', b === pick.btn ? 'true' : 'false');
        });
        img.src = sketchSrc(sci, pick.pose);
      }

      // Hide the toggle only if there is no real choice. pose=3 counts
      // as a choice when the button exists, even though it is lazy-loaded.
      if (available.length <= 1 && !p3) {
        poseToggle.setAttribute('data-unavailable', 'true');
      }

      // Slide the white pill to the active button.
      syncPill(poseToggle);
    });
    document.getElementById('modalSci').textContent = sci;
    document.getElementById('modalGenus').textContent = (sci.split(' ')[0] || '-');
    document.getElementById('modalCommon').textContent = '-';
    document.getElementById('modalAllTime').textContent = '-';
    document.getElementById('modalWindow').textContent = '-';
    // Window stat label tracks the picker; the whole stat is hidden for
    // the "all time" window since it would just echo the all-time count.
    var modalWinStat = document.getElementById('modalWindowStat');
    if (currentHours >= 1000000) {
      modalWinStat.style.display = 'none';
    } else {
      modalWinStat.style.display = '';
      document.getElementById('modalWindowLbl').textContent = windowLabel(currentHours);
    }
    document.getElementById('modalFirstSeen').textContent = '-';
    document.getElementById('modalRarity').textContent = '-';
    document.getElementById('modalRarity').classList.remove('rare');
    document.getElementById('modalDesc').textContent = 'Loading description...';
    document.getElementById('modalDesc').classList.add('placeholder');
    document.getElementById('modalRecordings').innerHTML = '<li class="rec-empty">Loading recordings...</li>';
    document.getElementById('modalRecCount').textContent = '';
    document.getElementById('modalWiki').href = wikiUrl(sci);
    document.getElementById('modalEbird').href = ebirdUrl(sci);
    // FLIP-style morph: scale + translate the modal-card from the
    // clicked atlas card's position to its natural centered size, so
    // the card *expands* into the detail view instead of just fading
    // in. The outer modal MUST become visible (aria-hidden=false)
    // before we apply the initial transform - the browser skips
    // layout for opacity-0 trees, which would freeze the morph at the
    // starting frame.
    var sourceCard = atlasGridEl
      ? atlasGridEl.querySelector('.bird-card[data-sci="' + sci.replace(/"/g, '\"') + '"]')
      : null;
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    morphModalOpen(modal.querySelector('.modal-card'), sourceCard);

    // Species detail (lifelist row + every detection).
    var loadSpecies = SPECIES_CACHE[sci]
      ? Promise.resolve(SPECIES_CACHE[sci])
      : fetchJson('/api/birdnet-api.php?action=species&sci=' + encodeURIComponent(sci)).then(function (j) {
          SPECIES_CACHE[sci] = j;
          return j;
        });
    loadSpecies.then(function (j) {
      var s = j.summary || {};
      document.getElementById('modalCommon').textContent = s.com || sci;
      document.getElementById('modalAllTime').textContent = fmtN(+s.total || 0);
      var winRow = ((DATA.recent && DATA.recent.species) || []).filter(function (x) { return x.sci === sci; })[0];
      document.getElementById('modalWindow').textContent = fmtN(winRow ? +winRow.n : 0);
      document.getElementById('modalFirstSeen').textContent = s.first_seen ? fmtRecTime(s.first_seen.split(' ')[0], s.first_seen.split(' ')[1]) : '-';
      var rar = rarityLabel(+s.total || 0, s.first_seen);
      var rarEl = document.getElementById('modalRarity');
      rarEl.textContent = rar;
      if (rar === 'rare') rarEl.classList.add('rare');
      var dets = j.detections || [];
      document.getElementById('modalRecCount').textContent = dets.length + ' captured';
      document.getElementById('modalRecordings').innerHTML = dets.length
        ? dets.map(function (d) {
            return '<li class="rec-row" data-file="' + (d.file || '') + '" data-date="' + (d.d || '') + '">'
              + '<button class="play" type="button" aria-label="play">' + ICON_PLAY + '</button>'
              + '<span class="when">' + fmtRecTime(d.d, d.t) + '<small>' + fmtDateLine(d.d, d.t) + '</small></span>'
              + '<span class="conf">' + ((+d.conf || 0) * 100).toFixed(0) + '%</span>'
              + '<div class="rec-spectro" aria-hidden="true">'
              +   '<div class="rec-spectro-loading">loading spectrogram...</div>'
              +   '<div class="rec-spectro-played"></div>'
              +   '<div class="rec-spectro-cursor"></div>'
              +   '<div class="rec-spectro-scrub" role="slider" aria-label="scrub" tabindex="0"></div>'
              + '</div>'
              + '</li>';
          }).join('')
        : '<li class="rec-empty">No recordings yet.</li>';
    }).catch(function () {
      document.getElementById('modalRecordings').innerHTML = '<li class="rec-empty">Failed to load recordings.</li>';
    });

    // Wikipedia summary (description + genus / family).
    var loadWiki = WIKI_CACHE[sci]
      ? Promise.resolve(WIKI_CACHE[sci])
      : fetchJson('/api/wiki.php?sci=' + encodeURIComponent(sci)).then(function (j) {
          WIKI_CACHE[sci] = j; return j;
        });
    loadWiki.then(function (j) {
      var desc = document.getElementById('modalDesc');
      desc.textContent = j.extract || 'No description available.';
      desc.classList.toggle('placeholder', !j.extract);
    }).catch(function () {
      var desc = document.getElementById('modalDesc');
      desc.textContent = 'No description available.';
      desc.classList.add('placeholder');
    });
  }
  function closeDetailModal() {
    var modal = document.getElementById('detail-modal');
    var modalCard = modal.querySelector('.modal-card');

    if (modal.getAttribute('aria-hidden') === 'true') {
      return;
    }

    if (modal.classList.contains('is-closing')) {
      return;
    }

    stopModalAudio();

    modal.classList.add('is-closing');
    document.body.style.overflow = '';

    if (modalCard) {
      modalCard.classList.remove('is-morphing');
      modalCard.style.transform = '';
      modalCard.style.opacity = '';
    }

    modalCloseTimer = setTimeout(function () {
      modal.setAttribute('aria-hidden', 'true');
      modal.classList.remove('is-closing');

      if (modalCard) {
        modalCard.classList.remove('is-morphing');
        modalCard.style.transform = '';
        modalCard.style.opacity = '';
      }

      modalCloseTimer = null;
    }, 230);
  }

  // FLIP morph helpers. We never resize/reposition the modal-card
  // permanently - we apply an inline transform that places it at the
  // source-card's position+scale, then clear it next frame so the
  // browser interpolates to the natural state. The same trick runs in
  // reverse on close.
  var atlasGridEl = document.getElementById('atlasGrid');
  function morphFromRect(cardEl) {
    if (!cardEl) return null;
    var r = cardEl.getBoundingClientRect();
    var winCx = window.innerWidth / 2;
    var winCy = window.innerHeight / 2;
    var dx = (r.left + r.width / 2) - winCx;
    var dy = (r.top + r.height / 2) - winCy;
    // Scale relative to the natural max width of the modal (~920px).
    var ratio = Math.max(0.18, Math.min(0.95, r.width / 920));
    return { dx: dx, dy: dy, ratio: ratio };
  }
  function morphModalOpen(modalCard, sourceCard) {
    if (!modalCard) return;
    modalCard.classList.remove('is-morphing');
    var from = morphFromRect(sourceCard);
    if (from) {
      modalCard.style.transformOrigin = '50% 50%';
      modalCard.style.transform =
        'translate3d(' + from.dx + 'px, ' + from.dy + 'px, 0) scale(' + from.ratio + ')';
      modalCard.style.opacity = '0';
    } else {
      modalCard.style.transform = 'translate3d(0, 8px, 0) scale(.96)';
      modalCard.style.opacity = '0';
    }
    // Force a layout flush so the starting state is committed, then
    // schedule the destination on the next tick. setTimeout(0) is
    // more reliable than rAF in some embedded/headless contexts.
    void modalCard.offsetWidth;
    setTimeout(function () {
      modalCard.classList.add('is-morphing');
      // Explicit identity matrix - browsers won't interpolate
      // between a matrix() and the keyword "none".
      modalCard.style.transform = 'translate3d(0px, 0px, 0px) scale(1)';
      modalCard.style.opacity = '1';
      setTimeout(function () {
        modalCard.classList.remove('is-morphing');
        modalCard.style.transform = '';
        modalCard.style.opacity = '';
      }, 420);
    }, 0);
  }
  function morphModalClose(modalCard, sourceCard, done) {
    if (!modalCard) {
      if (done) done();
      return;
    }

    var from = morphFromRect(sourceCard);

    modalCard.classList.add('is-morphing');

    if (from) {
      modalCard.style.transform =
        'translate3d(' + from.dx + 'px, ' + from.dy + 'px, 0) scale(' + from.ratio + ')';
    } else {
      modalCard.style.transform = 'translate3d(0, 8px, 0) scale(.96)';
    }

    modalCard.style.opacity = '0';

    // Hide the modal first, while the card is still opacity:0.
    // Then clean inline animation state on the next frame so it cannot flash.
    setTimeout(function () {
      if (done) done();

      requestAnimationFrame(function () {
        modalCard.classList.remove('is-morphing');
        modalCard.style.transform = '';
        modalCard.style.opacity = '';
      });
    }, 380);
  }

  // Pose toggle inside the modal. pose=1 and pose=2 are local/generated
  // illustrations. pose=3 is the Wikipedia photo and is loaded only
  // after the user explicitly clicks its button. A short opacity
  // transition makes the swap feel intentional rather than a hard cut.
  document.getElementById('modalPoseToggle').addEventListener('click', function (ev) {
    var btn = ev.target.closest && ev.target.closest('button');
    if (!btn || btn.getAttribute('data-unavailable') === 'true') return;
    var pose = +btn.dataset.pose;
    var toggle = document.getElementById('modalPoseToggle');
    [].slice.call(toggle.querySelectorAll('button')).forEach(function (b) {
      b.setAttribute('aria-current', b === btn ? 'true' : 'false');
    });
    syncPill(toggle);
    var img = document.getElementById('modalImg');
    var sci = document.getElementById('modalSci').textContent;
    img.classList.add('swapping');
    setTimeout(function () {
      img.src = sketchSrc(sci, pose);
      img.addEventListener('load', function once() {
        img.classList.remove('swapping');
        img.removeEventListener('load', once);
      });
    }, 180);
  });

  // Expose for debugging during dev - also lets the modal be opened
  // from outside the IIFE if needed.
  window.__openDetailModal = openDetailModal;
  window.__closeDetailModal = closeDetailModal;

  // ===== Admin overlay (settings / system / logs / tools) =====
  // Lives in the same shell as the rest of the app - the menu button
  // and return-to-atlas pill stay put. The slider hides; this overlay
  // takes over the body. Navigation is via the drawer menu, NOT
  // internal tabs (the drawer is the canonical nav surface).
  var adminEl = document.getElementById('adminScreen');
  var adminBody = document.getElementById('adminBody');
  var adminTitle = document.getElementById('adminTitle');
  var adminPollT = null;
  var adminSect = null;
  var ADMIN_TITLES = {
    settings: 'Settings',
    system: 'System',
    logs: 'Logs',
    tools: 'Tools',
  };
  function adminEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function adminFmtBytes(n) {
    if (!n) return '0 B';
    var u = ['B','KB','MB','GB','TB'];
    var i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(n < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
  }
  function adminFmtAge(s) {
    if (s == null) return '-';
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    return Math.round(s / 86400) + 'd';
  }
  // Admin endpoints rely on the session cookie set by /api/auth/login -
  // no Authorization header needed (and nothing sensitive in JS-readable
  // storage). credentials: 'same-origin' is the default but spelled out
  // for clarity.
  function adminApi(url) {
    return fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  }
  function openAdmin(section) {
    document.body.classList.add('admin-on');
    adminEl.setAttribute('aria-hidden', 'false');
    adminTitle.textContent = ADMIN_TITLES[section] || section;
    if (adminPollT) { clearInterval(adminPollT); adminPollT = null; }
    adminSect = section;
    if (section === 'settings') renderAdminSettings();
    else if (section === 'system') renderAdminSystem();
    else if (section === 'logs') renderAdminLogs();
    else if (section === 'tools') renderAdminTools();
  }
  function closeAdmin() {
    document.body.classList.remove('admin-on');
    adminEl.setAttribute('aria-hidden', 'true');
    if (adminPollT) { clearInterval(adminPollT); adminPollT = null; }
    adminSect = null;
  }

  function adminCard(title, value, sub, cls) {
    return '<div class="admin-card ' + (cls || '') + '">'
      + '<h3>' + adminEsc(title) + '</h3>'
      + '<div class="v">' + adminEsc(value) + '</div>'
      + (sub ? '<div class="sub">' + adminEsc(sub) + '</div>' : '')
      + '</div>';
  }
  function adminUnreachableHtml(reason) {
    return '<div class="admin-unreachable">Pi unreachable - ' + adminEsc(reason || 'no data') + '</div>';
  }

  function renderAdminSettings() {
    adminBody.innerHTML = '<p style="font:11px ui-monospace,monospace;color:var(--ink-soft);text-align:center">loading settings...</p>';
    fetch('/api/config.php', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (cfg) {
        var v = cfg.values || {};
        var preserve = cfg.preserve;
        adminBody.innerHTML =
          '<div class="admin-settings">'
          + settingsToggle('preserve', 'Preserve all recordings', "don't auto-delete", preserve)
          + settingsSlider('CONFIDENCE',  'Confidence threshold', 'min score to log a detection', v.CONFIDENCE,  0.1, 0.95, 0.05, 2)
          + settingsSlider('SENSITIVITY', 'Sensitivity',          'analyzer sensitivity',          v.SENSITIVITY, 0.5, 1.5,  0.05, 2)
          + settingsSlider('OVERLAP',     'Chunk overlap',        'seconds analyzed per pass',     v.OVERLAP,     0,   2.5,  0.1,  1)
          + settingsSegmented('FULL_DISK', 'When disk fills', '', v.FULL_DISK, [
              { v: 'keep',  label: 'keep' },
              { v: 'purge', label: 'purge' },
            ])
          + '<div class="menu-save-row">'
          + '  <span class="save-state" id="saveState"></span>'
          + '  <button type="button" id="saveBtn" disabled>save</button>'
          + '</div>'
          + '</div>';
        wireSettingsControls(adminBody);
        var saveBtn = document.getElementById('saveBtn');
        if (saveBtn) saveBtn.addEventListener('click', saveSettings);
      })
      .catch(function (err) {
        adminBody.innerHTML = adminUnreachableHtml('settings load failed (' + err + ')');
      });
  }

  function renderAdminSystem() {
    adminBody.innerHTML = '<p style="font:11px ui-monospace,monospace;color:var(--ink-soft);text-align:center">loading...</p>';
    function tick() {
      adminApi('/api/birdnet-status.php?action=diag')
        .then(function (r) { return r.text().then(function (raw) { return { status: r.status, raw: raw }; }); })
        .then(function (res) {
          var j = null;
          try { j = JSON.parse(res.raw); } catch (e) {}
          if (res.status !== 200 || !j) {
            adminBody.innerHTML = adminUnreachableHtml(
              !j ? 'birdnet-status.php not installed on the pi' : (j.error || 'HTTP ' + res.status)
            );
            return;
          }
          adminBody.innerHTML = adminSystemMarkup(j);
          wireAdminRestarts();
        })
        .catch(function (e) { adminBody.innerHTML = adminUnreachableHtml(e.message); });
    }
    tick();
    adminPollT = setInterval(tick, 6000);
  }
  function adminSystemMarkup(j) {
    var sys = j.system || {}, svc = j.services || {}, recLogs = j.recent_logs || {};
    var stream = sys.stream_data || {}, db = sys.birds_db || {};
    var streamAlert = !stream.exists || stream.newest_age_s == null || stream.newest_age_s > 600;
    var dbAlert = db.exists && db.modified_s > 3600;
    var keySvcs = ['birdnet_recording', 'birdnet_analysis', 'birdnet_log'];
    var dead = keySvcs.filter(function (n) { return svc[n] && svc[n].active !== 'active'; });
    var html = '<div class="admin-grid">';
    html += adminCard('recording pipeline', dead.length === 0 ? 'live' : (dead.length + ' down'),
      dead.length === 0 ? 'all services active' : dead.join(', '),
      dead.length === 0 ? '' : 'alert');
    html += adminCard('newest live audio',
      stream.newest_age_s == null ? 'no chunks' : adminFmtAge(stream.newest_age_s) + ' ago',
      stream.newest_name || '',
      streamAlert ? 'alert' : '');
    html += adminCard('birds.db updated',
      db.exists ? adminFmtAge(db.modified_s) + ' ago' : 'missing',
      db.mtime || '',
      dbAlert ? 'warn' : '');
    html += adminCard('uptime', (sys.uptime || {}).pretty || '-',
      'load ' + ((sys.uptime || {}).load || []).map(function (n) { return n.toFixed(2); }).join(' / '));
    html += adminCard('cpu temp',
      sys.temp_c != null ? sys.temp_c.toFixed(1) + '°C' : '-',
      sys.hostname + ' · ' + sys.kernel,
      sys.temp_c != null && sys.temp_c > 75 ? 'warn' : '');
    html += adminCard('memory used', sys.mem ? sys.mem.used_pct + '%' : '-',
      sys.mem ? adminFmtBytes(sys.mem.used_bytes) + ' / ' + adminFmtBytes(sys.mem.total_bytes) : '',
      sys.mem && sys.mem.used_pct > 92 ? 'warn' : '');
    html += adminCard('disk (birdsongs)', sys.disk_birds ? sys.disk_birds.used_pct + '%' : '-',
      sys.disk_birds ? adminFmtBytes(sys.disk_birds.total_bytes - sys.disk_birds.free_bytes) + ' / ' + adminFmtBytes(sys.disk_birds.total_bytes) : '',
      sys.disk_birds && sys.disk_birds.used_pct > 92 ? 'warn' : '');
    var audio = sys.audio || {}, cards = audio.arecord_l || [];
    var mic = cards.find ? cards.find(function (c) { return /usb-audio|microphone|mic/i.test(c); }) : null;
    // Without a USB mic, /proc/asound/cards only lists the Pi's HDMI
    // audio outputs - which aren't an input source. Flag that clearly
    // rather than showing "audio device: vc4hdmi0" as if it were a mic.
    html += adminCard('audio device',
      mic || (cards.length ? 'no microphone attached' : 'no audio devices'),
      mic ? '' : (cards[0] || ''),
      mic ? '' : 'warn');
    html += '</div>';

    html += '<h2 class="admin-section-head">services</h2>';
    html += '<table class="admin-tbl"><thead><tr><th>unit</th><th>state</th><th>enabled</th><th>since</th><th></th></tr></thead><tbody>';
    Object.keys(svc).forEach(function (name) {
      var s = svc[name];
      var pill = (s.active === 'active') ? 'active' : (s.active === 'failed' ? 'failed' : 'inactive');
      html += '<tr>'
        + '<td>' + adminEsc(name) + '</td>'
        + '<td><span class="pill ' + pill + '">' + adminEsc(s.active) + '</span></td>'
        + '<td>' + adminEsc(s.enabled) + '</td>'
        + '<td>' + adminEsc(s.since || '-') + '</td>'
        + '<td><button class="restart" data-unit="' + adminEsc(name) + '">restart</button></td>'
        + '</tr>';
    });
    html += '</tbody></table>';

    var conf = (sys.conf || {}).values || {};
    var rows = Object.keys(conf).map(function (k) {
      return '<tr><td>' + adminEsc(k) + '</td><td>' + adminEsc(conf[k]) + '</td></tr>';
    }).join('');
    if (rows) {
      html += '<h2 class="admin-section-head">birdnet.conf</h2>';
      html += '<table class="admin-tbl"><tbody>' + rows + '</tbody></table>';
    }
    if (Object.keys(recLogs).length) {
      html += '<h2 class="admin-section-head">recent journal</h2>';
      Object.keys(recLogs).forEach(function (u) {
        html += '<h3 style="font:9.5px ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-soft);margin:12px 0 6px">' + adminEsc(u) + '</h3>';
        html += '<div class="admin-logs-pane">' + adminEsc(recLogs[u] || '(empty)') + '</div>';
      });
    }
    return html;
  }
  function wireAdminRestarts() {
    adminBody.querySelectorAll('button.restart').forEach(function (b) {
      b.addEventListener('click', function () {
        var unit = b.dataset.unit;
        if (!confirm('Restart ' + unit + '?')) return;
        b.disabled = true; var old = b.textContent; b.textContent = '...';
        fetch('/api/birdnet-status.php?action=restart&unit=' + encodeURIComponent(unit), {
          method: 'POST', credentials: 'same-origin',
        })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            b.textContent = j.ok ? 'ok' : 'fail';
            setTimeout(function () { b.disabled = false; b.textContent = old; renderAdminSystem(); }, 1200);
          })
          .catch(function () { b.textContent = 'err'; b.disabled = false; setTimeout(function () { b.textContent = old; }, 1500); });
      });
    });
  }

  function renderAdminLogs() {
    var unit = 'birdnet_recording', lines = 120, autoScroll = true;
    adminBody.innerHTML =
      '<div class="admin-logs-toolbar">'
      + '  <label>unit</label><select id="adminLogsUnit">'
      // php-fpm unit name differs per Debian version (8.2 on Bookworm,
      // 8.4 on Trixie). List all three so the dropdown has the right one
      // regardless of host - birdnet-status.php's ALLOWED_UNITS already
      // skips ones systemd doesn't know about.
      + ['birdnet_recording','birdnet_analysis','birdnet_log','birdnet_stats','spectrogram_viewer','livestream','icecast2','caddy','php8.4-fpm','php8.3-fpm','php8.2-fpm']
          .map(function (u) { return '<option value="' + u + '">' + u + '</option>'; }).join('')
      + '  </select>'
      + '  <label>lines</label><input id="adminLogsLines" type="number" value="120" min="20" max="500" step="20">'
      + '</div>'
      + '<div class="admin-logs-pane" id="adminLogsOut">loading...</div>';
    var pane = document.getElementById('adminLogsOut');
    var sel = document.getElementById('adminLogsUnit');
    var linesIn = document.getElementById('adminLogsLines');
    sel.addEventListener('change', function () { unit = sel.value; tick(); });
    linesIn.addEventListener('change', function () { lines = +linesIn.value || 120; tick(); });
    pane.addEventListener('scroll', function () {
      autoScroll = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 20;
    });
    function tick() {
      adminApi('/api/birdnet-status.php?action=logs&unit=' + encodeURIComponent(unit) + '&lines=' + lines)
        .then(function (r) { return r.text().then(function (raw) { return { status: r.status, raw: raw }; }); })
        .then(function (res) {
          var j = null;
          try { j = JSON.parse(res.raw); } catch (e) {}
          if (res.status !== 200 || !j) {
            pane.textContent = 'pi unreachable - ' + (j && j.error ? j.error : 'no data');
            return;
          }
          pane.textContent = j.text || '(empty)';
          if (autoScroll) pane.scrollTop = pane.scrollHeight;
        });
    }
    tick();
    adminPollT = setInterval(tick, 4000);
  }

  function renderAdminTools() {
    var actions = [
      ['restart birdnet_recording', 'picks up live audio from the mic. restart this first if detections stall.', 'birdnet_recording'],
      ['restart birdnet_analysis',  'runs the neural net on recorded chunks. restart if detections are stuck.', 'birdnet_analysis'],
      ['restart birdnet_log',       'writes the sqlite db. restart if api/stats stops updating.', 'birdnet_log'],
      ['restart spectrogram_viewer','live fft view (legacy) - used by /birdnet/spectrogram.', 'spectrogram_viewer'],
      ['restart livestream',        'icecast feed for the drawer live-audio button.', 'livestream'],
      ['restart icecast2',          'web audio streaming server (fronts livestream).', 'icecast2'],
    ];
    var html = '<div class="admin-actions-grid">';
    actions.forEach(function (a) {
      html += '<div class="admin-action">'
        + '<h4>' + adminEsc(a[0]) + '</h4>'
        + '<p>' + adminEsc(a[1]) + '</p>'
        + '<button class="run" type="button" data-unit="' + adminEsc(a[2]) + '">run</button>'
        + '<div class="out" data-out="' + adminEsc(a[2]) + '"></div>'
        + '</div>';
    });
    html += '</div>';
    html += '<h2 class="admin-section-head">heal / update</h2>';
    html += '<div class="admin-actions-grid">';
    function deployCard(title, desc, lines) {
      return '<div class="admin-action deploy">'
        + '<h4>' + adminEsc(title) + '</h4>'
        + '<p>' + adminEsc(desc) + '</p>'
        + '<pre>' + adminEsc(lines.join('\n')) + '</pre>'
        + '<button class="copy" type="button">copy</button>'
        + '</div>';
    }
    html += deployCard('pull latest from github',
      'fetches the newest AvianVisitors + BirdNET-Pi changes; the symlinks already in /BirdSongs/Extracted/ pick up new code on the next request.',
      [
        'cd ~/BirdNET-Pi && git pull',
        '# substitute the right php-fpm unit if your debian ships a different version:',
        'sudo systemctl reload caddy "$(systemctl list-unit-files \'php*-fpm.service\' --no-legend | awk \'{print $1; exit}\')"',
      ]);
    html += deployCard('rerun install_services.sh',
      'refreshes every symlink + service file. safe to run anytime; only takes ~10 seconds.',
      [
        'cd ~/BirdNET-Pi && ./scripts/install_services.sh',
      ]);
    html += '</div>';
    adminBody.innerHTML = html;
    // Wire restart buttons + copy buttons.
    adminBody.querySelectorAll('.admin-action button.run').forEach(function (b) {
      b.addEventListener('click', function () {
        var unit = b.dataset.unit;
        if (!confirm('restart ' + unit + '?')) return;
        b.disabled = true; var old = b.textContent; b.textContent = '...';
        var out = adminBody.querySelector('.out[data-out="' + unit.replace(/[^a-z0-9_.-]/gi,'_') + '"]');
        fetch('/api/birdnet-status.php?action=restart&unit=' + encodeURIComponent(unit), {
          method: 'POST', credentials: 'same-origin',
        })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            b.textContent = j.ok ? 'restarted' : 'failed';
            if (out) out.textContent = (j.ok ? 'ok' : 'rc=' + j.rc) + (j.out ? '\n' + j.out : '');
            setTimeout(function () { b.disabled = false; b.textContent = old; }, 2000);
          })
          .catch(function (e) {
            b.textContent = 'error'; b.disabled = false;
            if (out) out.textContent = e.message || 'request failed';
            setTimeout(function () { b.textContent = old; }, 2000);
          });
      });
    });
    adminBody.querySelectorAll('.admin-action button.copy').forEach(function (b) {
      b.addEventListener('click', function () {
        var pre = b.previousElementSibling;
        if (!pre) return;
        navigator.clipboard.writeText(pre.textContent).then(function () {
          var old = b.textContent; b.textContent = 'copied ✓';
          setTimeout(function () { b.textContent = old; }, 1400);
        });
      });
    });
  }

  // Initial load: if URL has a sci hash, jump to atlas, highlight, and
  // open the modal.
  if (readHash()) { go(2); highlightAtlas(readHash()); openDetailModal(readHash()); }
  // Admin overlay routing: #admin=system|logs|tools opens the admin
  // screen with that sub-tab. Clearing the hash closes it.
  function readAdminHash() {
    var m = location.hash.match(/^#admin=([a-z]+)/);
    return m ? m[1] : null;
  }
  // #about - brief explainer popup; reached via /about (302 -> /#about)
  // or the masthead eyebrow. aria-hidden drives the CSS fade/slide.
  function openAbout()  { document.getElementById('about-modal').setAttribute('aria-hidden', 'false'); }
  function closeAbout() { document.getElementById('about-modal').setAttribute('aria-hidden', 'true'); }
  function syncRouter() {
    window.__lastHashchange = Date.now();
    var sci = readHash();
    var adm = readAdminHash();
    if (location.hash === '#about') openAbout(); else closeAbout();
    if (adm) { openAdmin(adm); return; }
    closeAdmin();
    if (sci) { go(2); highlightAtlas(sci); openDetailModal(sci); }
    else     { highlightAtlas(null); closeDetailModal(); }
  }
  if (readAdminHash()) openAdmin(readAdminHash());
  if (location.hash === '#about') openAbout();
  window.addEventListener('hashchange', syncRouter);

  // Modal interactions: backdrop / close button -> clear the hash.
  document.getElementById('detail-modal').addEventListener('click', function (ev) {
    if (ev.target.dataset && ev.target.dataset.close === '1') {
      if (location.hash) { location.hash = ''; } else { closeDetailModal(); }
    }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' &&
        document.getElementById('detail-modal').getAttribute('aria-hidden') === 'false') {
      if (location.hash) { location.hash = ''; } else { closeDetailModal(); }
    }
  });

  // About popup: backdrop / close / explore button all carry data-close,
  // which clears the hash and routes through syncRouter -> closeAbout.
  // The masthead eyebrow opens it; Escape dismisses it.
  document.getElementById('about-modal').addEventListener('click', function (ev) {
    if (ev.target.dataset && ev.target.dataset.close === '1') {
      if (location.hash) { location.hash = ''; } else { closeAbout(); }
    }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' &&
        document.getElementById('about-modal').getAttribute('aria-hidden') === 'false') {
      if (location.hash) { location.hash = ''; } else { closeAbout(); }
    }
  });
  document.getElementById('aboutLink').addEventListener('click', function () {
    location.hash = '#about';
  });

  // Shared decode context for spectrogram generation. Lives once for
  // the page; lazily created on first expand to avoid bootstrapping
  // WebAudio if no one ever opens a row.
  var _specAudioCtx = null;
  function getSpecCtx() {
    if (!_specAudioCtx) {
      var C = window.AudioContext || window.webkitAudioContext;
      if (C) _specAudioCtx = new C();
    }
    return _specAudioCtx;
  }

  // Cache decoded AudioBuffers per file so repeated expand/collapse on
  // the same row doesn't re-fetch + re-decode the mp3.
  var _decodedCache = {};

  // Minimal in-place Cooley-Tukey radix-2 FFT (n must be a power of 2).
  // Operates on parallel real/imag Float32Array buffers. ~30 lines and
  // fast enough for our ~1024-sample windows of 3-second clips.
  function _fft(real, imag) {
    var n = real.length;
    var j = 0;
    for (var i = 0; i < n - 1; i++) {
      if (i < j) {
        var tr = real[i]; real[i] = real[j]; real[j] = tr;
        var ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
      }
      var k = n >> 1;
      while (k <= j) { j -= k; k >>= 1; }
      j += k;
    }
    for (var stage = 2; stage <= n; stage *= 2) {
      var half = stage >> 1;
      var ang = -2 * Math.PI / stage;
      var wR = Math.cos(ang), wI = Math.sin(ang);
      for (var sBase = 0; sBase < n; sBase += stage) {
        var cR = 1, cI = 0;
        for (var sb = 0; sb < half; sb++) {
          var a = sBase + sb;
          var b = a + half;
          var trA = real[b] * cR - imag[b] * cI;
          var tiA = real[b] * cI + imag[b] * cR;
          real[b] = real[a] - trA;
          imag[b] = imag[a] - tiA;
          real[a] = real[a] + trA;
          imag[a] = imag[a] + tiA;
          var nR = cR * wR - cI * wI;
          cI = cR * wI + cI * wR;
          cR = nR;
        }
      }
    }
  }

  // Paint an STFT spectrogram onto the strip's canvas. y-axis is the
  // bird audible band (~200 Hz - ~10 kHz) on a mildly compressed log
  // scale; x-axis is time across the whole clip; colour is dB
  // magnitude mapped to our warm ink palette over the dark paper-ink
  // ground.
  function paintSpectrogram(canvas, audioBuffer) {
    // Defer to the next animation frame so the canvas has been laid out
    // (the parent strip may still be mid-transition expanding from 0).
    // Without this, subsequent expansions paint onto a zero-sized canvas.
    requestAnimationFrame(function () {
      _paintSpectrogramNow(canvas, audioBuffer);
    });
  }
  function _paintSpectrogramNow(canvas, audioBuffer) {
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    // Read parent strip's box, not the canvas (canvas might be 0-sized
    // briefly during expansion). The strip's expanded height is 88px;
    // width is the row width.
    var strip = canvas.parentElement;
    var cssW = strip ? strip.clientWidth : (canvas.clientWidth || 600);
    var cssH = strip ? strip.clientHeight : (canvas.clientHeight || 88);
    if (cssW < 32 || cssH < 32) {
      // Strip still collapsing in. Retry a frame later.
      requestAnimationFrame(function () { _paintSpectrogramNow(canvas, audioBuffer); });
      return;
    }
    var W = Math.max(1, Math.floor(cssW * dpr));
    var H = Math.max(1, Math.floor(cssH * dpr));
    canvas.width = W; canvas.height = H;

    var ctx = canvas.getContext('2d');
    var samples = audioBuffer.getChannelData(0);
    var sr = audioBuffer.sampleRate;
    var FFT_SIZE = 1024;
    var bins = FFT_SIZE >> 1;
    var nyquist = sr / 2;

    // Frequency-band mapping (Hz -> bin) for the bird-relevant band.
    // Most North American songbirds + corvids range 250 Hz - 8 kHz, but
    // hummingbirds, kinglets, and warblers reach 12 kHz. Push the cap
    // up so we don't miss the high-frequency tail.
    var fLo = 200, fHi = Math.min(12000, nyquist);
    var binLo = Math.max(1, Math.floor(fLo / nyquist * bins));
    var binHi = Math.min(bins - 1, Math.ceil(fHi / nyquist * bins));

    // Hann window
    var win = new Float32Array(FFT_SIZE);
    for (var i = 0; i < FFT_SIZE; i++) {
      win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
    }

    // Choose a hop that lays exactly W columns over the whole clip.
    var hop = Math.max(1, Math.floor((samples.length - FFT_SIZE) / Math.max(1, W - 1)));
    var real = new Float32Array(FFT_SIZE);
    var imag = new Float32Array(FFT_SIZE);

    var imgData = ctx.createImageData(W, H);
    var data = imgData.data;

    // Page-paper ground; ink intensifies where there's audio energy.
    // Matches the sketch palette (paper #f5f0e6 background, ink
    // #1a1612 strokes).
    var BG_R = 245, BG_G = 240, BG_B = 230;
    var FG_R = 26,  FG_G = 22,  FG_B = 18;
    for (var p = 0; p < data.length; p += 4) {
      data[p] = BG_R; data[p + 1] = BG_G; data[p + 2] = BG_B; data[p + 3] = 255;
    }

    // Precompute row -> bin map (log-ish so low freqs get more space).
    var rowToBin = new Int32Array(H);
    for (var row = 0; row < H; row++) {
      var t = 1 - row / (H - 1); // 1 at top, 0 at bottom
      var bin = Math.round(binLo + (binHi - binLo) * Math.pow(t, 1.55));
      rowToBin[row] = Math.max(binLo, Math.min(binHi, bin));
    }

    for (var col = 0; col < W; col++) {
      var start = col * hop;
      if (start + FFT_SIZE > samples.length) break;
      for (var s = 0; s < FFT_SIZE; s++) {
        real[s] = samples[start + s] * win[s];
        imag[s] = 0;
      }
      _fft(real, imag);
      for (var row2 = 0; row2 < H; row2++) {
        var bin2 = rowToBin[row2];
        var re = real[bin2], im = imag[bin2];
        var mag = Math.sqrt(re * re + im * im);
        // log compress; -75 .. -10 dB -> 0 .. 1
        var db = 20 * Math.log10(mag + 1e-9);
        var v = (db + 75) / 65;
        if (v < 0) v = 0; else if (v > 1) v = 1;
        // Ink-on-paper palette: low energy -> paper, high energy -> ink.
        // Smoothstep for a softer falloff between the two extremes.
        var e = v * v * (3 - 2 * v);
        var r = BG_R + Math.round((FG_R - BG_R) * e);
        var g = BG_G + Math.round((FG_G - BG_G) * e);
        var b = BG_B + Math.round((FG_B - BG_B) * e);
        var px = (row2 * W + col) * 4;
        data[px] = r; data[px + 1] = g; data[px + 2] = b; data[px + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    canvas.classList.add('ready');
  }

  // Lazy-add + paint the canvas-based spectrogram for a row's strip.
  // Decoded buffers are cached per file so re-expanding is instant.
  function ensureSpectroImage(row) {
    var file = row && row.dataset.file;
    if (!file) return;
    var strip = row.querySelector('.rec-spectro');
    if (!strip) return;
    var loadingEl = strip.querySelector('.rec-spectro-loading');
    var canvas = strip.querySelector('canvas');
    if (canvas && canvas.classList.contains('ready')) {
      if (loadingEl) loadingEl.style.display = 'none';
      return;
    }
    if (!canvas) {
      canvas = document.createElement('canvas');
      var played = strip.querySelector('.rec-spectro-played');
      strip.insertBefore(canvas, played);
    }
    if (loadingEl) {
      loadingEl.style.display = '';
      loadingEl.textContent = 'rendering spectrogram...';
    }

    function done() {
      if (loadingEl) loadingEl.style.display = 'none';
    }
    function fail(reason) {
      if (loadingEl) {
        loadingEl.style.display = '';
        loadingEl.textContent = reason || 'spectrogram unavailable';
      }
    }

    if (_decodedCache[file]) {
      paintSpectrogram(canvas, _decodedCache[file]);
      done();
      return;
    }
    var ctx = getSpecCtx();
    if (!ctx) { fail('WebAudio not available'); return; }
    fetch('/api/recording.php?file=' + encodeURIComponent(file))
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) { return ctx.decodeAudioData(buf); })
      .then(function (audioBuffer) {
        _decodedCache[file] = audioBuffer;
        paintSpectrogram(canvas, audioBuffer);
        done();
      })
      .catch(function (e) {
        fail('spectrogram failed: ' + (e && e.message ? e.message : ''));
      });
  }

  // Per-recording row interactions in the modal:
  //   - Clicking anywhere on the row toggles the spectrogram strip
  //     (independent of playback). Click again to collapse.
  //   - Clicking the play button toggles audio playback. Playback shows
  //     the moving cursor on whatever strip is already expanded; if the
  //     strip is collapsed, playing also expands it.
  //   - Clicking on the spectrogram itself scrubs (handled in the
  //     mousedown/touchstart wiring further down).
  document.getElementById('modalRecordings').addEventListener('click', function (ev) {
    if (!ev.target.closest) return;
    // Scrub-region clicks are handled by the mousedown wiring below.
    if (ev.target.closest('.rec-spectro-scrub')) return;

    var playBtn = ev.target.closest('.play');
    if (playBtn) {
      // Play / pause toggle. Three cases:
      //   (a) clicking the playing row's button -> pause (KEEP audio
      //       alive so the user can scrub then resume).
      //   (b) clicking a paused row's button (it's still modalRecBtn,
      //       audio still alive, just paused) -> resume from cursor.
      //   (c) clicking a different row's button -> stop the old, start
      //       the new.
      var prow = playBtn.closest('.rec-row');
      var pfile = prow && prow.dataset.file;
      if (!pfile) return;

      if (modalRecBtn === playBtn && modalAudio) {
        // Same row's button - toggle pause/resume.
        if (modalAudio.paused) {
          playBtn.setAttribute('data-active', 'true');
          playBtn.innerHTML = ICON_PAUSE;
          modalAudio.play().catch(function () {});
        } else {
          pauseModalAudio();
        }
        return;
      }

      // Different row (or no current playback) - stop any current,
      // start fresh.
      stopModalAudio();
      playBtn.setAttribute('data-active', 'true');
      playBtn.innerHTML = ICON_PAUSE;
      modalRecBtn = playBtn;
      prow.classList.add('expanded');
      ensureSpectroImage(prow);
      var strip = prow.querySelector('.rec-spectro');
      var audio = new Audio('/api/recording.php?file=' + encodeURIComponent(pfile));
      modalAudio = audio;
      audio.addEventListener('loadedmetadata', function () {
        strip.classList.add('armed');
      });
      audio.addEventListener('playing', startCursorLoop);
      audio.addEventListener('pause', stopCursorLoop);
      audio.addEventListener('ended', function () {
        // Natural end: rewind cursor + keep audio so user can replay.
        stopCursorLoop();
        var p = strip.querySelector('.rec-spectro-played');
        var c = strip.querySelector('.rec-spectro-cursor');
        if (p) p.style.width = '0%';
        if (c) c.style.left = '0%';
        if (modalAudio) modalAudio.currentTime = 0;
        if (modalRecBtn) {
          modalRecBtn.removeAttribute('data-active');
          modalRecBtn.innerHTML = ICON_PLAY;
        }
      });
      audio.addEventListener('error', function () {
        stopModalAudio();
        playBtn.innerHTML = '<span style="font-size:8px">!</span>';
        setTimeout(function () { playBtn.innerHTML = ICON_PLAY; }, 1500);
      });
      audio.play().catch(function () { stopModalAudio(); });
      return;
    }

    // Row click anywhere else -> toggle strip open/closed.
    var row = ev.target.closest('.rec-row');
    if (!row) return;
    var willExpand = !row.classList.contains('expanded');
    if (willExpand) {
      row.classList.add('expanded');
      ensureSpectroImage(row);
    } else {
      // Collapsing the row where playback is happening also stops audio
      // (the cursor would just be hidden otherwise).
      if (modalRecBtn && modalRecBtn.closest('.rec-row') === row) stopModalAudio();
      row.classList.remove('expanded');
    }
  });

  // Scrub by clicking / dragging on the spectrogram strip.
  (function () {
    var dragRow = null;
    function seekFromEvent(row, clientX) {
      if (!modalAudio || !modalAudio.duration) return;
      var rowBtn = row.querySelector('.play');
      if (rowBtn !== modalRecBtn) return;
      var strip = row.querySelector('.rec-spectro');
      var rect = strip.getBoundingClientRect();
      var pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      modalAudio.currentTime = pct * modalAudio.duration;
      // Repaint cursor + played immediately so the user sees the scrub
      // even when audio is paused (rAF loop isn't running then).
      var pctStr = (pct * 100).toFixed(2) + '%';
      var played = strip.querySelector('.rec-spectro-played');
      var cur = strip.querySelector('.rec-spectro-cursor');
      if (played) played.style.width = pctStr;
      if (cur) cur.style.left = pctStr;
    }
    document.getElementById('modalRecordings').addEventListener('mousedown', function (ev) {
      var s = ev.target.closest && ev.target.closest('.rec-spectro-scrub');
      if (!s) return;
      var row = s.closest('.rec-row');
      if (!row || !row.classList.contains('expanded')) return;
      dragRow = row;
      seekFromEvent(row, ev.clientX);
      ev.preventDefault();
    });
    document.addEventListener('mousemove', function (ev) {
      if (!dragRow) return;
      seekFromEvent(dragRow, ev.clientX);
    });
    document.addEventListener('mouseup', function () { dragRow = null; });
    // Touch.
    document.getElementById('modalRecordings').addEventListener('touchstart', function (ev) {
      var s = ev.target.closest && ev.target.closest('.rec-spectro-scrub');
      if (!s) return;
      var row = s.closest('.rec-row');
      if (!row || !row.classList.contains('expanded')) return;
      dragRow = row;
      seekFromEvent(row, ev.touches[0].clientX);
      ev.preventDefault();
    }, { passive: false });
    document.addEventListener('touchmove', function (ev) {
      if (!dragRow) return;
      seekFromEvent(dragRow, ev.touches[0].clientX);
    });
    document.addEventListener('touchend', function () { dragRow = null; });
  })();

  // Any element with data-sci is a "jump to that bird's atlas card"
  // affordance: atlas cards themselves, stats list rows (top species /
  // first detections), and any future surface that wants to point at a
  // bird. Action chips inside cards stop propagation themselves.
  function jumpToSci(sci) {
    if (!sci) return;
    if (location.hash !== '#sci=' + encodeURIComponent(sci)) {
      location.hash = '#sci=' + encodeURIComponent(sci);
    } else {
      // Same hash -> still re-highlight (the user clicked it again).
      go(2); highlightAtlas(sci);
    }
  }
  document.addEventListener('click', function (ev) {
    if (!ev.target.closest) return;
    var card = ev.target.closest('.bird-card');
    if (card) {
      if (ev.target.closest('.actions, .spectro-wrap')) return;
      return jumpToSci(card.dataset.sci);
    }
    var row = ev.target.closest('li[data-sci]');
    if (row) return jumpToSci(row.dataset.sci);
  });

  // After the atlas re-renders (window change, fresh fetch), re-apply
  // any active hash so the highlight survives a rebuild.
  var _origRenderAtlas = renderAtlas;
  renderAtlas = function () {
    _origRenderAtlas();
    var s = readHash();
    if (s) highlightAtlas(s);
  };
})();