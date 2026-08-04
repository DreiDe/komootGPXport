console.log("komootGPXport activated");

// === Utility functions ===

const jsonToGpx = (coords) => {
    let gpx =
        `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<gpx version="1.1" creator="komootGPXport" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata></metadata>
  <rte>
  ${coords.map((coord) => {
            return `<rtept lat="${coord.lat}" lon="${coord.lng}"><ele>${coord.alt}</ele></rtept>`
        }).join('\n')
        }
  </rte>
</gpx>`;

    return gpx;
}

const downloadGpx = (filename, text) => {
    let elem = document.createElement('a');
    elem.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(text));
    elem.setAttribute('download', filename);

    elem.style.display = 'none';
    document.body.appendChild(elem);

    elem.click();

    document.body.removeChild(elem);
}

// === Name helpers ===

function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*]+/g, '').replace(/\s+/g, ' ').trim();
}

function getParsedPageData() {
    // Cache is keyed by URL so SPA navigations always get fresh data
    if (getParsedPageData._cache && getParsedPageData._url === location.href) {
        return getParsedPageData._cache;
    }
    getParsedPageData._cache = null;
    getParsedPageData._url = location.href;
    const scripts = document.querySelectorAll('script');
    for (let script of scripts) {
        const content = script.textContent || script.innerHTML;
        if (content.includes('kmtBoot.setProps(')) {
            const match = content.match(/kmtBoot\.setProps\("(.+)"\)/);
            if (match) {
                // The props are a JSON string embedded in a JS string literal, so
                // unescape it as a string literal first, then parse the JSON.
                for (const parse of [
                    () => JSON.parse(JSON.parse('"' + match[1] + '"')),
                    () => JSON.parse(match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')),
                ]) {
                    try {
                        getParsedPageData._cache = parse();
                        return getParsedPageData._cache;
                    } catch (e) {}
                }
            }
        }
    }
    return null;
}

function getTourName() {
    const data = getParsedPageData();
    return data?.page?._embedded?.tour?.name || 'route';
}

function getCollectionName() {
    const data = getParsedPageData();
    return data?.page?._embedded?.collectionHal?.name?.trim() || 'collection';
}

function getCollectionLegName(tourId) {
    const data = getParsedPageData();
    const items = data?.page?._embedded?.collectionHal?._embedded?.compilation?._embedded?.items;
    if (!items) return null;
    const leg = items.find(i => String(i.id) === String(tourId));
    return leg?.name || null;
}

// === Coordinate fetching (upstream method first, then fallback) ===

function getCoordsFromScriptTags() {
    // Upstream method: parse kmtBoot.setProps() from <script> tags
    const rawData = getParsedPageData();
    if (!rawData) return null;
    const coordinates = rawData.page?._embedded?.tour?._embedded?.coordinates?.items;
    return (coordinates && coordinates.length > 0) ? coordinates : null;
}

function getCoordsFromGetProps() {
    // Fallback: use kmtBoot.getProps() API
    try {
        const page = kmtBoot.getProps().page;
        if (!page) return { coords: null, tourLink: null };
        const coords = page.linksEmbedded?.tour?.linksEmbedded?.coordinates?.attributes?.items;
        const tourLink = page.links?.tour?.href;
        return { coords: coords && coords.length > 0 ? coords : null, tourLink };
    } catch (e) {
        console.error('komootGPXport: kmtBoot.getProps() failed:', e);
        return { coords: null, tourLink: null };
    }
}

// Private tours are only readable with the session cookie, and the API lives on
// api.komoot.* while the page is served from www.komoot.*, so every API request
// must opt in to sending credentials cross-origin.
function fetchJson(url) {
    return fetch(url, { credentials: 'include' }).then(response => {
        if (!response.ok) throw new Error(`HTTP error ${response.status} for ${url}`);
        return response.json();
    });
}

function fetchCoordsFromTourLink(tourLink) {
    // Fetch coordinates via API links
    return fetchJson(tourLink)
        .then(tour_data => {
            const coordinates_link = tour_data._links?.coordinates?.href;
            if (!coordinates_link) throw new Error('Tour response has no coordinates link');
            return fetchJson(coordinates_link);
        })
        .then(coordinates_data => coordinates_data.items);
}

function getApiHost() {
    // api.komoot.de serves every locale; keep the page's host family when possible
    return 'https://api.komoot.de';
}

function getTourIdFromUrl() {
    const match = location.pathname.match(/\/(?:tour|smarttour)\/(?:[a-z]+-)?(\d+)/);
    return match ? match[1] : null;
}

function fetchCoordsByTourId(tourId) {
    return fetchJson(`${getApiHost()}/v007/tours/${tourId}/coordinates`)
        .then(data => {
            if (!data.items || data.items.length === 0) throw new Error('No coordinates in API response');
            return data.items;
        });
}

function reportFailure(err) {
    console.error('komootGPXport: Failed to read route coordinates:', err);
    alert('There was an error reading the points of your route. If this keeps happening feel free to open an issue.');
}

function downloader() {
    const filename = sanitizeFilename(getTourName()) + '.gpx';
    const finish = (items) => downloadGpx(filename, jsonToGpx(items));

    // Method 1: Parse <script> tags (upstream approach)
    const scriptCoords = getCoordsFromScriptTags();
    if (scriptCoords) {
        finish(scriptCoords);
        return;
    }

    // Method 2: kmtBoot.getProps() fallback
    const { coords, tourLink } = getCoordsFromGetProps();
    if (coords) {
        finish(coords);
        return;
    }

    // Method 3: Fetch from the tour API link exposed by the page, if there is one
    // Method 4: Otherwise derive the tour ID from the URL and hit the API directly.
    // Saved tour pages embed neither coordinates nor a tour link, so this is the
    // path that actually serves /tour/<id> pages.
    const tourId = getTourIdFromUrl();
    const attempt = tourLink
        ? fetchCoordsFromTourLink(tourLink).catch(err => {
              if (!tourId) throw err;
              console.warn('komootGPXport: tour link failed, falling back to tour ID:', err);
              return fetchCoordsByTourId(tourId);
          })
        : tourId
            ? fetchCoordsByTourId(tourId)
            : Promise.reject(new Error('Could not determine the tour ID from the page or URL'));

    attempt.then(finish).catch(reportFailure);
}

// === Planner page: add button next to "Save route" ===

function waitForElm(selector) {
    return new Promise(resolve => {
        if (document.querySelector(selector)) {
            return resolve(document.querySelector(selector));
        }

        const observer = new MutationObserver(() => {
            if (document.querySelector(selector)) {
                observer.disconnect();
                resolve(document.querySelector(selector));
            }
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    });
}

function addPlannerButton() {
    waitForElm("[data-test-id=p_tour_save]").then((saveBtn) => {
        if (document.querySelector("#download-gpx"))
            return;
        const downloadBtn = saveBtn.cloneNode(true);
        downloadBtn.id = 'download-gpx';
        downloadBtn.removeAttribute('data-test-id');
        downloadBtn.removeAttribute('href');
        downloadBtn.style.cursor = 'pointer';
        // Replace icon with download icon
        const svg = downloadBtn.querySelector('svg');
        if (svg) {
            svg.innerHTML = '<path d="M10 2.5v10m0 0L6.25 8.75M10 12.5l3.75-3.75M3.33 14.17v.83a2.5 2.5 0 002.5 2.5h8.34a2.5 2.5 0 002.5-2.5v-.83" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>';
        }
        // Replace text
        const textEl = downloadBtn.querySelector('p');
        if (textEl) textEl.textContent = 'Download GPX (free)';
        downloadBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            downloader();
        });
        // Match spacing with the cross button on the right
        saveBtn.parentElement.style.gap = '8px';
        saveBtn.parentElement.insertBefore(downloadBtn, saveBtn);
    });
}

// === Tour/collection page: add button after "Send to Phone" ===

function makeDownloadButton(templateBtn, id, clickHandler) {
    const downloadBtn = templateBtn.cloneNode(true);
    downloadBtn.id = id;
    downloadBtn.removeAttribute('href');
    downloadBtn.setAttribute('role', 'button');
    // Prefer the Navigate button's class (green) over Save/Send-to-Phone (brown)
    const navigateBtn = document.querySelector('a[role="button"][aria-label="Navigate"]');
    if (navigateBtn && navigateBtn !== templateBtn) downloadBtn.className = navigateBtn.className;
    downloadBtn.style.cursor = 'pointer';
    const textEl = downloadBtn.querySelector('p');
    if (textEl) textEl.textContent = 'Download GPX (free)';
    const svg = downloadBtn.querySelector('svg');
    if (svg) {
        svg.innerHTML = '<path d="M10 2v11m0 0l-3.5-3.5M10 13l3.5-3.5M3 15v1a2 2 0 002 2h10a2 2 0 002-2v-1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>';
    }
    downloadBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clickHandler();
    });
    return downloadBtn;
}

function getTourIdFromContext(sendToPhoneLink) {
    // Walk up to find a nearby tour link and extract the tour ID
    let el = sendToPhoneLink.parentElement;
    for (let i = 0; i < 5; i++) {
        if (!el) break;
        el = el.parentElement;
        const tourLink = el.querySelector('a[href*="/tour/"]');
        if (tourLink) {
            const match = tourLink.href.match(/\/tour\/(\d+)/);
            if (match) return match[1];
        }
    }
    return null;
}

function downloadByTourId(tourId) {
    const colName = sanitizeFilename(getCollectionName());
    const legName = getCollectionLegName(tourId);
    const filename = legName
        ? sanitizeFilename(colName + ' - ' + legName) + '.gpx'
        : colName + '.gpx';

    fetchCoordsByTourId(tourId)
        .then(items => downloadGpx(filename, jsonToGpx(items)))
        .catch(reportFailure);
}

function addTourButtons() {
    const isTourPage = /\/(tour|smarttour)\//.test(window.location.pathname);
    const isCollectionPage = /\/collection\//.test(window.location.pathname);
    if (!isTourPage && !isCollectionPage) return;

    if (isTourPage) {
        if (document.querySelector('#download-gpx-tour')) return;
        const navigateBtn = document.querySelector('a[role="button"][aria-label="Navigate"]');
        const saveBtn = document.querySelector('a[role="button"][aria-label="Save"]');
        const templateBtn = navigateBtn || saveBtn;
        if (!templateBtn) return;
        const container = templateBtn.parentElement;
        if (!container) return;
        // Insert between Navigate and Save to match the expected button order
        const anchor = saveBtn && saveBtn.parentElement === container ? saveBtn : null;
        container.insertBefore(makeDownloadButton(templateBtn, 'download-gpx-tour', downloader), anchor);
        return;
    }

    // Collection page: one download button per tour card.
    // Each card has id="tour_XXXXXX" and contains Save/Navigate buttons as stable anchors.
    let idx = 0;
    document.querySelectorAll('[data-test-id="tour-card"]').forEach(card => {
        const tourId = card.id?.replace('tour_', '');
        if (!/^\d+$/.test(tourId)) return;

        const btnId = idx === 0 ? 'download-gpx-tour' : `download-gpx-tour-${idx}`;
        if (document.getElementById(btnId)) { idx++; return; }

        // Use the Save button as template (present on both Chrome and Firefox)
        const saveBtn = card.querySelector('a[role="button"][aria-label="Save"]');
        const navigateBtn = card.querySelector('a[role="button"][aria-label="Navigate with device"]') ||
                            card.querySelector('a[role="button"][aria-label="Navigate"]');
        const templateBtn = saveBtn || navigateBtn;
        if (!templateBtn) return;

        const container = templateBtn.parentElement;
        if (!container) return;

        // Insert before Save to place it first in the action row
        container.insertBefore(
            makeDownloadButton(templateBtn, btnId, () => downloadByTourId(tourId)),
            saveBtn || null
        );
        idx++;
    });
}

// === Init: observe DOM and add buttons as appropriate ===

const observer = new MutationObserver(() => {
    addPlannerButton();
    addTourButtons();
});
observer.observe(document.body, {
    childList: true,
    subtree: true
});

// Also run once immediately
addPlannerButton();
addTourButtons();