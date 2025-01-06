// ==UserScript==
// @name         GG.Deals Everywhere
// @namespace    MrAwesomeFalcon
// @version      0.4
// @description  Integrates GG.Deals prices across multiple Steam trading and gifting sites with caching, rate limiting, special-item handling, and one-click price lookups.
// @match        https://lestrades.com/*
// @match        https://steamtrades.com/*
// @match        https://www.steamtrades.com/*
// @match        https://steamgifts.com/*
// @match        https://www.steamgifts.com/*
// @match        https://barter.vg/*
// @match        https://www.barter.vg/*
// @connect      gg.deals
// @connect      steamcommunity.com
// @connect      mannco.store
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @run-at       document-end
// @homepageURL  https://github.com/MrAwesomeFalcon/GG-Deals-Everywhere/
// @supportURL   https://github.com/MrAwesomeFalcon/GG-Deals-Everywhere/issues
// @downloadURL  https://github.com/MrAwesomeFalcon/GG-Deals-Everywhere/blob/main/GG-Deals-Everywhere.user.js
// @updateURL    https://github.com/MrAwesomeFalcon/GG-Deals-Everywhere/blob/main/GG-Deals-Everywhere.user.js
// ==/UserScript==

(function() {
    'use strict';

    // CONFIG
    const INSERT_GG_BEFORE_SWI = false;
    const AUTO_CHECK_COUNT = 0; // number of prices to automatically check every page load. CAREFUL this will almost certainly rate limit you immediately.
    const CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // one week
    const SHOW_CACHED_IMMEDIATELY = true; // load items from the cache
    const ITEMS_PER_PAGE = 50; // items per page in the cache view
    const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
    const GAME_NAME_WIDTH = 70; // width of game names for making cache view look nicer
    const ICON_URL = 'https://i.imgur.com/s4oAJ1k.png'; // url used for the button icon
    // https://imgur.com/a/dTvpB2K Album of custom icons I made

    // Special items settings
    const SPECIAL_CACHE_DURATION = 24 * 60 * 60 * 1000;
    const SPECIAL_ITEMS = ["Gems", "Sack of Gems", "Mann Co. Supply Crate Key"];

    // REQUEST QUEUE TO LIMIT RATE (10 requests/minute => 1 request/6 seconds)
    const REQUEST_INTERVAL_MS = 6000; // 6 seconds between each request, gg.deals allows 10 requests a minute, this should help stay within that limit.
    let requestQueue = [];
    setInterval(() => {
        if (requestQueue.length > 0) {
            const nextReq = requestQueue.shift();
            GM_xmlhttpRequest(nextReq);
        }
    }, REQUEST_INTERVAL_MS);

    function queueGMRequest(options) {
        requestQueue.push(options);
    }

    GM_addStyle(`
        .ggdeals-price-container {
            display: inline-block !important;
        }
        .ggdeals-price-container * {
            line-height: 1 !important;
        }
    `);

    let cachedPrices = GM_getValue("cachedPrices", {});
    if (typeof cachedPrices !== 'object' || cachedPrices === null) {
        cachedPrices = {};
    }

    pruneOldEntries();

    GM_registerMenuCommand("View Cached Prices", viewCachedPrices);
    GM_registerMenuCommand("Clear Cached Prices", clearCachedPrices);
    GM_registerMenuCommand("Soft load (only missing)", softLoad);
    GM_registerMenuCommand("Hard load (refresh all)", hardLoad);

    // We'll keep arrays to track name-based items vs. appid-based items
    let allItems = []; // name-based
    let freshGames = [];
    let appItems = []; // appid-based
    let freshApps = [];

    window.addEventListener('load', init);

    function init() {
        // 1) Normal /game/ links scanning
        scanMatchesPages();

        // 2) SWI-block scanning
        scanSWIBlocks();

        // 3) "Offer" page scanning (labels with input[name="game[]"] + a[data-appid])
        scanOfferItems();

        // 4) Auto-load if desired
        maybeAutoLoadFresh();
    }

    // -------------------------------------------------------------------------
    // A) Lestrades "Matches" scanning
    // -------------------------------------------------------------------------
    function scanMatchesPages() {
        const traderHeadings = document.querySelectorAll("h1.trader");
        traderHeadings.forEach((heading) => {
            const matchesTable = heading.nextElementSibling;
            if (!matchesTable || !matchesTable.matches("table.matches")) return;

            const gameLinks = matchesTable.querySelectorAll("a[href^='/game/'][data-appid], a[href^='/game/'][data-subid]");
            gameLinks.forEach((link) => {
                const gameName = link.textContent.trim();
                const appIdFromLink = link.getAttribute('data-appid') ? 'app/' + link.getAttribute('data-appid') : 'sub/' + link.getAttribute('data-subid');
                const btnId = `ggdeals_btn_${Math.random().toString(36).substr(2,9)}`;

                const container = document.createElement('span');
                container.classList.add('ggdeals-price-container');
                container.style.marginLeft = '5px';
                container.innerHTML = `
                    <a id="${btnId}" style="cursor: pointer; border:none; outline:none; background:transparent; text-decoration:none;">
                        <img src="${ICON_URL}" width="14" height="14"
                             title="GG.Deals: Click to load/update price info!"
                             style="border:none; outline:none; background:transparent;"/>
                    </a>
                    <small id="${btnId}_after"></small>
                `;
                link.insertAdjacentElement('afterend', container);

                if (appIdFromLink && !isNaN(appIdFromLink.substr(4))) {
                    // AppID-based item
                    appItems.push({ appId: appIdFromLink, btnId });

                    // Always refetch on click
                    const btnElem = document.getElementById(btnId);
                    btnElem.addEventListener('click', () => {
                        fetchItemPriceByAppId(appIdFromLink, (priceInfo, gameTitle) => {
                            if (priceInfo !== "No price found") {
                                storeInCacheByAppId(appIdFromLink, priceInfo, gameTitle);
                            }
                            const resultElem = document.getElementById(`${btnId}_after`);
                            if (resultElem) {
                                resultElem.innerHTML = ` (<a href="${getItemURLByAppId(appIdFromLink)}" target="_blank" style="text-decoration:none;">${priceInfo}</a>)`;
                            }
                        });
                    });

                    // Show cached if fresh or mark as needed
                    const cached = cachedPrices[appIdFromLink];
                    if (SHOW_CACHED_IMMEDIATELY && cached && isCacheFresh(cached.name || appIdFromLink, cached.timestamp)) {
                        const resultElem = document.getElementById(`${btnId}_after`);
                        resultElem.innerHTML = ` (<a href="${getItemURLByAppId(appIdFromLink)}" target="_blank" style="text-decoration:none;">${cached.price}</a>)`;
                    } else if (!cached) {
                        freshApps.push({ btnId, appId: appIdFromLink });
                    } else if (!isCacheFresh(cached.name || appIdFromLink, cached.timestamp)) {
                        freshApps.push({ btnId, appId: appIdFromLink });
                    }
                } else {
                    // Name-based item
                    allItems.push({ gameName, btnId });

                    // Always refetch on click
                    const btnElem = document.getElementById(btnId);
                    btnElem.addEventListener('click', () => {
                        fetchItemPriceByName(gameName, (priceInfo, foundName, foundAppId) => {
                            if (priceInfo !== "No price found") {
                                storeInCache(gameName, priceInfo, foundName, foundAppId);
                            }
                            const resultElem = document.getElementById(`${btnId}_after`);
                            if (resultElem) {
                                const linkUrl = foundAppId ? getItemURLByAppId(foundAppId) : getItemURL(foundName || gameName);
                                resultElem.innerHTML = ` (<a href="${linkUrl}" target="_blank" style="text-decoration:none;">${priceInfo}</a>)`;
                            }
                        });
                    });

                    const cached = cachedPrices[gameName];
                    if (SHOW_CACHED_IMMEDIATELY && cached && isCacheFresh(cached.name || gameName, cached.timestamp)) {
                        const resultElem = document.getElementById(`${btnId}_after`);
                        resultElem.innerHTML = ` (<a href="${getItemURL(gameName)}" target="_blank" style="text-decoration:none;">${cached.price}</a>)`;
                    } else if (!cached) {
                        freshGames.push({ btnId, gameName });
                    } else if (cached && !isCacheFresh(cached.name || gameName, cached.timestamp)) {
                        freshGames.push({ btnId, gameName });
                    }
                }
            });
        });
    }

    // -------------------------------------------------------------------------
    // B) SWI-block scanning
    // -------------------------------------------------------------------------
    function scanSWIBlocks() {
        const appDivs = document.querySelectorAll('div.swi-block.swi-boxed[data-appid]');
        appDivs.forEach(div => {
            addAppButton(div);
        });

        // If new SWI blocks appear after the page load:
        const observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        const newDivs = node.matches?.('div.swi-block.swi-boxed[data-appid]')
                            ? [node]
                            : node.querySelectorAll?.('div.swi-block.swi-boxed[data-appid]') || [];
                        newDivs.forEach(div => {
                            addAppButton(div);
                        });
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function addAppButton(div) {
        // Check if the SWI is showing due to an image
        const parentLink = div.closest('a.swi');
        if (parentLink && parentLink.querySelector('img.swi')) {
            return; // do not add
        }
        if (div.classList.contains('gg-processed')) return;
        div.classList.add('gg-processed');

        const appId = div.getAttribute('data-appid');
        const btnId = `ggdeals_app_btn_${Math.random().toString(36).substr(2,9)}`;
        const container = document.createElement('span');
        container.classList.add('ggdeals-price-container');
        container.style.marginLeft = '5px';
        container.innerHTML = `
            <a id="${btnId}" style="cursor:pointer; border:none; outline:none; background:transparent; text-decoration:none;">
              <img src="${ICON_URL}" title="GG.Deals: Click to load/update price info by AppID!"
                   style="border:none; outline:none; background:transparent; width:14px; height:14px;"/>
            </a>
            <span id="${btnId}_after" style="font-size:1em"></span>
        `;

        if (INSERT_GG_BEFORE_SWI) {
            div.insertAdjacentElement('beforebegin', container);
        } else {
            div.insertAdjacentElement('afterend', container);
        }

        appItems.push({ appId, btnId });

        const btnElem = document.getElementById(btnId);
        btnElem.addEventListener('click', () => {
            fetchItemPriceByAppId(appId, (priceInfo, gameTitle) => {
                if (priceInfo !== "No price found") {
                    storeInCacheByAppId(appId, priceInfo, gameTitle);
                }
                const resultElem = document.getElementById(`${btnId}_after`);
                if (resultElem) {
                    resultElem.innerHTML = ` (<a href="${getItemURLByAppId(appId)}" target="_blank" style="text-decoration:none;">${priceInfo}</a>)`;
                }
            });
        });

        const cached = cachedPrices[appId];
        if (SHOW_CACHED_IMMEDIATELY && cached && isCacheFresh(cached.name || appId, cached.timestamp)) {
            const resultElem = document.getElementById(`${btnId}_after`);
            resultElem.innerHTML = ` (<a href="${getItemURLByAppId(appId)}" target="_blank" style="text-decoration:none;">${cached.price}</a>)`;
        } else if (!cached) {
            freshApps.push({ btnId, appId });
        } else if (!isCacheFresh(cached.name || appId, cached.timestamp)) {
            freshApps.push({ btnId, appId });
        }
    }

    // -------------------------------------------------------------------------
    // C) Offer-page scanning
    // -------------------------------------------------------------------------
    function scanOfferItems() {
        // Look for: <label><input name="game[]" ...> <a data-appid="..."></a> ...
        const offerInputs = document.querySelectorAll('label input[name="game[]"]');
        offerInputs.forEach(input => {
            const label = input.closest('label');
            if (!label) return;

            const anchor = label.querySelector('a[data-appid]');
            if (!anchor) return;

            const appId = anchor.getAttribute('data-appid');
            if (!appId) return; // skip if empty

            // Insert a button just like we do for SWI-block items:
            if (label.classList.contains('gg-offer-processed')) return;
            label.classList.add('gg-offer-processed');

            const btnId = `ggdeals_offer_${Math.random().toString(36).substr(2,9)}`;
            const container = document.createElement('span');
            container.classList.add('ggdeals-price-container');
            container.style.marginLeft = '5px';
            container.innerHTML = `
                <a id="${btnId}" style="cursor: pointer; border:none; outline:none; background:transparent; text-decoration:none;">
                    <img src="${ICON_URL}" width="14" height="14"
                         title="GG.Deals: Click to load/update price info (Offer Page)!"
                         style="border:none; outline:none; background:transparent;"/>
                </a>
                <small id="${btnId}_after"></small>
            `;
            label.appendChild(container);

            // For app-based logic
            appItems.push({ appId, btnId });

            // Always refetch on click
            const btnElem = document.getElementById(btnId);
            btnElem.addEventListener('click', () => {
                fetchItemPriceByAppId(appId, (priceInfo, gameTitle) => {
                    if (priceInfo !== "No price found") {
                        storeInCacheByAppId(appId, priceInfo, gameTitle);
                    }
                    const resultElem = document.getElementById(`${btnId}_after`);
                    if (resultElem) {
                        resultElem.innerHTML = ` (<a href="${getItemURLByAppId(appId)}" target="_blank" style="text-decoration:none;">${priceInfo}</a>)`;
                    }
                });
            });

            // Check if we have a fresh cache
            const cached = cachedPrices[appId];
            if (SHOW_CACHED_IMMEDIATELY && cached && isCacheFresh(cached.name || appId, cached.timestamp)) {
                const resultElem = document.getElementById(`${btnId}_after`);
                resultElem.innerHTML = ` (<a href="${getItemURLByAppId(appId)}" target="_blank" style="text-decoration:none;">${cached.price}</a>)`;
            } else if (!cached) {
                freshApps.push({ btnId, appId });
            } else if (!isCacheFresh(cached.name || appId, cached.timestamp)) {
                freshApps.push({ btnId, appId });
            }
        });
    }

    // -------------------------------------------------------------------------
    // 4) Auto-load logic
    // -------------------------------------------------------------------------
    function maybeAutoLoadFresh() {
        // Autoload fresh name-based items
        if (AUTO_CHECK_COUNT > 0 && freshGames.length > 0) {
            const limit = Math.min(AUTO_CHECK_COUNT, freshGames.length);
            for (let i = 0; i < limit; i++) {
                setTimeout(() => {
                    const elem = document.getElementById(freshGames[i].btnId);
                    if (elem) elem.click();
                }, 500 * i);
            }
        }

        // Autoload fresh app-based items
        if (AUTO_CHECK_COUNT > 0 && freshApps.length > 0) {
            const limit = Math.min(AUTO_CHECK_COUNT, freshApps.length);
            for (let i = 0; i < limit; i++) {
                setTimeout(() => {
                    const elem = document.getElementById(freshApps[i].btnId);
                    if (elem) elem.click();
                }, 500 * i);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Menu commands: cache view, soft/hard load, etc.
    // -------------------------------------------------------------------------
    function viewCachedPrices() {
        const now = Date.now();
        const allEntries = Object.entries(cachedPrices).map(([key, data]) => {
            const ageMs = now - data.timestamp;
            const ageStr = formatAge(ageMs);
            const isAppId = !isNaN(key);
            let usedName = data.name || key;
            const url = data.appid ? getItemURLByAppId(data.appid) : getItemURL(usedName);

            return {
                gameName: usedName,
                price: data.price,
                ageStr,
                url,
                appid: data.appid || (isAppId ? key : null)
            };
        });

        // Sort by gameName alphabetically
        allEntries.sort((a, b) => a.gameName.localeCompare(b.gameName));
        showPagedPopup(allEntries);
    }

    function showPagedPopup(allEntries) {
        let currentPage = 0;
        let filteredEntries = [...allEntries];
        const totalPages = () => Math.ceil(filteredEntries.length / ITEMS_PER_PAGE);

        const overlay = document.createElement('div');
        overlay.style = `
            position: fixed; top:0; left:0; width:100%; height:100%;
            background-color: rgba(0,0,0,0.7); z-index:999999; display:flex;
            align-items:center; justify-content:center;
        `;

        const popup = document.createElement('div');
        popup.style = `
            background:#333; color:#fff; padding:20px; border-radius:8px; width:80%;
            max-height:80%; overflow-y:auto; box-sizing:border-box; position:relative;
            font-family: monospace;
        `;

        const closeXButton = document.createElement('button');
        closeXButton.textContent = '✖';
        closeXButton.style = `
            position:absolute; top:10px; right:10px; background:transparent; color:#fff;
            border:none; font-size:20px; cursor:pointer;
        `;
        closeXButton.addEventListener('click', () => document.body.removeChild(overlay));
        popup.appendChild(closeXButton);

        const h1 = document.createElement('h1');
        h1.textContent = `Cached Prices (${filteredEntries.length} cached items)`;
        h1.style.marginTop = '0';
        h1.style.paddingRight = '30px';
        popup.appendChild(h1);

        // Search bar
        const searchDiv = document.createElement('div');
        searchDiv.style.marginBottom = '10px';
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = 'Search game name or appid...';
        searchInput.style.marginRight = '5px';

        const searchButton = document.createElement('button');
        searchButton.textContent = 'Search';
        searchButton.style.marginRight = '5px';

        const clearButton = document.createElement('button');
        clearButton.textContent = 'Clear';

        searchButton.addEventListener('click', () => {
            const query = searchInput.value.trim().toLowerCase();
            if (query) {
                filteredEntries = allEntries.filter(e =>
                    e.gameName.toLowerCase().includes(query) ||
                    (e.appid && e.appid.toString().includes(query))
                );
            } else {
                filteredEntries = [...allEntries];
            }
            currentPage = 0;
            renderPage();
            h1.textContent = `Cached Prices (${filteredEntries.length} cached items)`;
        });

        clearButton.addEventListener('click', () => {
            searchInput.value = '';
            filteredEntries = [...allEntries];
            currentPage = 0;
            renderPage();
            h1.textContent = `Cached Prices (${filteredEntries.length} cached items)`;
        });

        searchDiv.appendChild(searchInput);
        searchDiv.appendChild(searchButton);
        searchDiv.appendChild(clearButton);
        popup.appendChild(searchDiv);

        const resultsDiv = document.createElement('div');
        popup.appendChild(resultsDiv);

        const paginationDiv = document.createElement('div');
        paginationDiv.style.marginTop = '10px';

        const prevButton = document.createElement('button');
        prevButton.textContent = 'Previous';
        prevButton.style.marginRight = '5px';

        const nextButton = document.createElement('button');
        nextButton.textContent = 'Next';

        prevButton.addEventListener('click', () => {
            if (currentPage > 0) {
                currentPage--;
                renderPage();
            }
        });
        nextButton.addEventListener('click', () => {
            if (currentPage < totalPages() - 1) {
                currentPage++;
                renderPage();
            }
        });

        paginationDiv.appendChild(prevButton);
        paginationDiv.appendChild(nextButton);
        popup.appendChild(paginationDiv);

        const closeButton = document.createElement('button');
        closeButton.textContent = 'Close';
        closeButton.style = `
            margin-top:10px; background:#555; color:#fff; border:none;
            padding:5px 10px; cursor:pointer;
        `;
        closeButton.addEventListener('click', () => {
            document.body.removeChild(overlay);
        });
        popup.appendChild(closeButton);

        overlay.appendChild(popup);
        document.body.appendChild(overlay);

        function renderPage() {
            resultsDiv.innerHTML = '';
            const start = currentPage * ITEMS_PER_PAGE;
            const end = start + ITEMS_PER_PAGE;
            const pageItems = filteredEntries.slice(start, end);
            if (pageItems.length === 0) {
                resultsDiv.innerHTML = 'No results.';
                return;
            }

            const lines = pageItems.map(e =>
                formatLine(e.gameName, e.price, e.ageStr, e.url, e.appid)
            );
            resultsDiv.innerHTML = `<pre>${lines.join('\n')}</pre>`;
        }

        renderPage();
    }

    function formatLine(gameName, price, ageStr, url, appid) {
        let displayPrice = price;
        const nameLower = gameName.toLowerCase();
        if ((nameLower.includes("gems") || nameLower.includes("sack of gems")) && displayPrice.startsWith('$')) {
            displayPrice += "/1000";
        }

        let fullName = padRight(gameName, GAME_NAME_WIDTH);
        // Reserve space for AppID block: 9 chars "[1230530]" or "[       ]"
        if (appid) {
            fullName += ` [${appid}]`;
        } else {
            fullName += ` [       ]`;
        }

        return `${fullName} ${displayPrice} (Age: ${ageStr}) ${urlLink("GG Deals", url)}`;
    }

    function urlLink(text, url) {
        return `<a href="${url}" target="_blank">${text}</a>`;
    }

    function padRight(str, length) {
        if (str.length < length) {
            return str + ' '.repeat(length - str.length);
        }
        return str;
    }

    function clearCachedPrices() {
        if (confirm("Are you sure you want to clear all cached prices?")) {
            cachedPrices = {};
            GM_setValue("cachedPrices", cachedPrices);
            alert("Cached prices cleared.");
        }
    }

    function softLoad() {
        // For name-based items
        allItems.forEach(item => {
            const { gameName, btnId } = item;
            const cached = cachedPrices[gameName];
            let shouldLoad = false;
            if (!SHOW_CACHED_IMMEDIATELY) {
                shouldLoad = true;
            } else {
                if (!cached || !isCacheFresh(cached.name || gameName, cached.timestamp) || cached.price === "No price found") {
                    shouldLoad = true;
                }
            }
            if (shouldLoad) {
                const elem = document.getElementById(btnId);
                if (elem) elem.click();
            }
        });

        // For appId items
        appItems.forEach(item => {
            const { appId, btnId } = item;
            const cached = cachedPrices[appId];
            let shouldLoad = false;
            if (!SHOW_CACHED_IMMEDIATELY) {
                shouldLoad = true;
            } else {
                if (!cached || !isCacheFresh(cached.name || appId, cached.timestamp) || cached.price === "No price found") {
                    shouldLoad = true;
                }
            }
            if (shouldLoad) {
                const elem = document.getElementById(btnId);
                if (elem) elem.click();
            }
        });
    }

    function hardLoad() {
        // For name-based items
        allItems.forEach(item => {
            const { gameName, btnId } = item;
            fetchItemPriceByName(gameName, (priceInfo, foundName, foundAppId) => {
                if (priceInfo !== "No price found") {
                    storeInCache(gameName, priceInfo, foundName, foundAppId);
                }
                const resultElem = document.getElementById(`${btnId}_after`);
                if (resultElem) {
                    const linkUrl = foundAppId ? getItemURLByAppId(foundAppId) : getItemURL(foundName || gameName);
                    resultElem.innerHTML = ` (<a href="${linkUrl}" target="_blank" style="text-decoration:none;">${priceInfo}</a>)`;
                }
            });
        });

        // For appId items
        appItems.forEach(item => {
            const { appId, btnId } = item;
            fetchItemPriceByAppId(appId, (priceInfo, gameTitle) => {
                if (priceInfo !== "No price found") {
                    storeInCacheByAppId(appId, priceInfo, gameTitle);
                }
                const resultElem = document.getElementById(`${btnId}_after`);
                if (resultElem) {
                    resultElem.innerHTML = ` (<a href="${getItemURLByAppId(appId)}" target="_blank" style="text-decoration:none;">${priceInfo}</a>)`;
                }
            });
        });
    }

    // -------------------------------------------------------------------------
    // Storing in cache
    // -------------------------------------------------------------------------
    function storeInCache(gameName, priceInfo, foundName, foundAppId) {
        if (foundAppId) {
            // If we used to store by gameName, remove that entry
            if (cachedPrices[gameName] && cachedPrices[gameName].appid !== foundAppId) {
                delete cachedPrices[gameName];
            }
            // Store by appId only
            cachedPrices[foundAppId] = {
                price: priceInfo,
                name: foundName || gameName,
                appid: foundAppId,
                timestamp: Date.now()
            };
            if (document.querySelector('#wedge') && foundAppId)
            {
                GM_xmlhttpRequest({
                	method: 'POST',
                    url: 'https://lestrades.com/?action=ajax;sa=gg',
                    data: 'gg=' + encodeURI(priceInfo) + '&app=' + foundAppId + '&' + window.unsafeWindow.we_sessvar + '=' + window.unsafeWindow.we_sessid,
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                });
            }
        } else {
            // No appid
            cachedPrices[gameName] = {
                price: priceInfo,
                name: foundName || gameName,
                timestamp: Date.now()
            };
        }
        GM_setValue("cachedPrices", cachedPrices);
    }

    function storeInCacheByAppId(appId, priceInfo, gameTitle) {
        // If previously stored by name, remove that entry
        for (const [key, val] of Object.entries(cachedPrices)) {
            if (key !== appId && val.appid === appId) {
                delete cachedPrices[key];
            }
        }
        cachedPrices[appId] = {
            price: priceInfo,
            name: gameTitle || appId,
            appid: appId,
            timestamp: Date.now()
        };
        GM_setValue("cachedPrices", cachedPrices);
        if (document.querySelector('#wedge')) {
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://lestrades.com/?action=ajax;sa=gg',
                data: 'gg=' + encodeURI(priceInfo) + '&app=' + appId + '&' + window.unsafeWindow.we_sessvar + '=' + window.unsafeWindow.we_sessid,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
        }
    }

    // -------------------------------------------------------------------------
    // Fetch logic (always fresh on manual click)
    // -------------------------------------------------------------------------
    function fetchItemPriceByName(gameName, callback) {
        if (gameName === "Gems" || gameName === "Sack of Gems") {
            const url = `https://steamcommunity.com/market/listings/753/753-Sack%20of%20Gems`;
            queueGMRequest({
                method: "GET",
                url: url,
                onload: (response) => {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(response.responseText, "text/html");
                    let priceElem = doc.querySelector(".market_commodity_orders_header_promote");
                    let price = priceElem ? priceElem.textContent.trim() : "No price found";
                    if (price === "No price found") {
                        const alternativeElem = doc.querySelector(".market_listing_price");
                        if (alternativeElem) {
                            price = alternativeElem.textContent.trim();
                        }
                    }
                    callback(price, gameName, null);
                },
                onerror: () => callback("No price found", gameName, null),
                ontimeout: () => callback("No price found", gameName, null)
            });
            return;
        } else if (gameName === "Mann Co. Supply Crate Key") {
            const url = `https://mannco.store/item/440-mann-co-supply-crate-key`;
            queueGMRequest({
                method: "GET",
                url: url,
                onload: (response) => {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(response.responseText, "text/html");
                    let priceElem = doc.querySelector(".ecurrency");
                    let price = priceElem ? priceElem.textContent.trim() : "No price found";
                    callback(price, gameName, null);
                },
                onerror: () => callback("No price found", gameName, null),
                ontimeout: () => callback("No price found", gameName, null)
            });
            return;
        }

        const url = `https://gg.deals/search/?platform=1,2,4,2048,4096,8192&title=${encodeURIComponent(gameName)}`;
        queueGMRequest({
            method: "GET",
            url: url,
            onload: (response) => {
                const parser = new DOMParser();
                const doc = parser.parseFromString(response.responseText, "text/html");
                let priceElems = doc.querySelectorAll(".price-inner.numeric");
                let prices = Array.from(priceElems).map(el => el.textContent.trim());
                let price;
                if (prices.length === 0) {
                    price = "No price found";
                } else if (prices.length === 1) {
                    price = prices[0];
                } else {
                    let officialPrice = prices[0];
                    let keyshopPrice = prices[1];
                    price = `${officialPrice} | ${keyshopPrice}`;
                }

                let foundName = null;
                let foundAppId = null;
                const firstResultLink = doc.querySelector(".game-info-title[href*='/steam/app/']");
                if (firstResultLink) {
                    const href = firstResultLink.getAttribute('href');
                    const appIdMatch = href.match(/\/steam\/app\/(\d+)\//);
                    if (appIdMatch) {
                        foundAppId = appIdMatch[1];
                    }
                    const nameElem = firstResultLink.querySelector("[itemprop='name']");
                    if (nameElem) {
                        foundName = nameElem.textContent.trim();
                    }
                }
                callback(price, foundName || gameName, foundAppId);
            },
            onerror: () => callback("No price found", gameName, null),
            ontimeout: () => callback("No price found", gameName, null)
        });
    }

    function fetchItemPriceByAppId(appId, callback) {
        const url = `https://gg.deals/steam/${appId}/`;
        queueGMRequest({
            method: "GET",
            url: url,
            onload: (response) => {
                const parser = new DOMParser();
                const doc = parser.parseFromString(response.responseText, "text/html");
                let priceElems = doc.querySelectorAll(".price-inner.numeric");
                let prices = Array.from(priceElems).map(el => el.textContent.trim());
                let price;

                if (prices.length === 0) {
                    price = "No price found";
                } else if (prices.length === 1) {
                    price = prices[0];
                } else {
                    let officialPrice = prices[0];
                    let keyshopPrice = prices[1];
                    price = `${officialPrice} | ${keyshopPrice}`;
                }

                let nameElem = doc.querySelector('a[itemprop="item"].active span[itemprop="name"]');
                let gameTitle = nameElem ? nameElem.textContent.trim() : null;

                callback(price, gameTitle);
            },
            onerror: () => callback("No price found", null),
            ontimeout: () => callback("No price found", null)
        });
    }

    // -------------------------------------------------------------------------
    // URL helpers
    // -------------------------------------------------------------------------
    function getItemURL(gameName) {
        if (gameName === "Gems" || gameName === "Sack of Gems") {
            return `https://steamcommunity.com/market/listings/753/753-Sack%20of%20Gems`;
        } else if (gameName === "Mann Co. Supply Crate Key") {
            return `https://mannco.store/item/440-mann-co-supply-crate-key`;
        }
        return `https://gg.deals/search/?platform=1,2,4,2048,4096,8192&title=${encodeURIComponent(gameName)}`;
    }

    function getItemURLByAppId(appId) {
        return `https://gg.deals/steam/${appId}/`;
    }

    // -------------------------------------------------------------------------
    // Freshness / pruning
    // -------------------------------------------------------------------------
    function isCacheFresh(gameNameOrId, timestamp) {
        const nameLower = (gameNameOrId + "").toLowerCase();
        const now = Date.now();
        const age = now - timestamp;
        if (SPECIAL_ITEMS.some(item => item.toLowerCase() === nameLower)) {
            return age < SPECIAL_CACHE_DURATION;
        }
        return age < CACHE_DURATION;
    }

    function pruneOldEntries() {
        const now = Date.now();
        let changed = false;
        for (const [key, data] of Object.entries(cachedPrices)) {
            if ((now - data.timestamp) > MONTH_MS) {
                delete cachedPrices[key];
                changed = true;
            }
        }
        if (changed) {
            GM_setValue("cachedPrices", cachedPrices);
        }
    }

    function formatAge(ms) {
        const ageInDays = ms / (1000*60*60*24);
        const ageInHours = ageInDays * 24;
        const ageInMinutes = ageInHours * 60;

        if (ageInHours < 1) {
            return `${ageInMinutes.toFixed(2)} minutes`;
        } else if (ageInHours < 24) {
            return `${ageInHours.toFixed(2)} hours`;
        }
        return `${ageInDays.toFixed(2)} days`;
    }

})();
