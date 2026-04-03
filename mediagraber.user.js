// ==UserScript==
// @name         MediaGrabber - Studia Online
// @namespace    https://studia-online.pl/
// @version      1.0.0
// @description  Pobiera materiały (PDF i wideo) z platformy studia-online.pl z automatycznym nazewnictwem PP.TT.MM
// @author       MediaGrabber
// @match        https://studia-online.pl/kurs/*
// @grant        GM_xmlhttpRequest
// @connect      studia-online.pl
// @connect      ultracloud.pl
// @connect      *.ultracloud.pl
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ===== HELPERS =====

    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    /**
     * Zastępuje znaki niedozwolone w nazwach plików Windows znakiem "-".
     * Dozwolone są litery, cyfry, spacje, myślniki, podkreślenia, kropki, polskie znaki itp.
     */
    function sanitizeFilename(name) {
        // Znaki niedozwolone w Windows: \ / : * ? " < > |
        return name
            .replace(/[\\/:*?"<>|]/g, '-')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Buduje nazwę pliku wg reguły: PP.TT.MM - [tytuł max 100 znaków].[rozszerzenie]
     */
    function buildFilename(pp, tt, mm, materialTitle, ext) {
        const prefix = `${pad2(pp)}.${pad2(tt)}.${pad2(mm)}`;
        let cleanTitle = sanitizeFilename(materialTitle);
        if (cleanTitle.length > 100) {
            cleanTitle = cleanTitle.substring(0, 100).trim();
        }
        return `${prefix} - ${cleanTitle}.${ext}`;
    }

    /**
     * Usuwa wiodący numer i kropkę z tytułu materiału ("3. Nazwa" → "Nazwa").
     */
    function stripLeadingNumber(text) {
        return text.replace(/^\d+\.\s*/, '').trim();
    }

    /**
     * Wyodrębnia numer wiodący z tytułu ("3. Nazwa" → 3).
     */
    function extractLeadingNumber(text) {
        const m = text.match(/^(\d+)\./);
        return m ? parseInt(m[1], 10) : 0;
    }

    /**
     * Wykonuje żądanie HTTP i zwraca tekst odpowiedzi.
     */
    function fetchPage(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                onload: (response) => {
                    if (response.status >= 200 && response.status < 400) {
                        resolve(response.responseText);
                    } else {
                        reject(new Error(`HTTP ${response.status} dla: ${url}`));
                    }
                },
                onerror: (err) => reject(new Error(`Błąd sieci: ${url}`)),
                ontimeout: () => reject(new Error(`Timeout: ${url}`))
            });
        });
    }

    function parseHtml(htmlText) {
        const parser = new DOMParser();
        return parser.parseFromString(htmlText, 'text/html');
    }

    // ===== PARSOWANIE STRONY =====

    /**
     * Pobiera listę przedmiotów (subjects) ze strony.
     * Przedmioty są w .course-topic__list .course-topic__link
     */
    function parseSubjectsFromDoc(doc) {
        const subjects = [];
        const links = doc.querySelectorAll('.course-topic__list .course-topic__link');
        links.forEach((link) => {
            const text = link.textContent.trim();
            const url = link.href.split('#')[0];
            const num = extractLeadingNumber(text);
            subjects.push({ num, text, url });
        });
        return subjects;
    }

    /**
     * Pobiera listę lekcji (tematy) z #kursLekcje na stronie.
     */
    function parseLessonsFromDoc(doc) {
        const lessons = [];
        const links = doc.querySelectorAll('#kursLekcje .course-lesson__link');
        links.forEach((link) => {
            const text = link.textContent.trim();
            const url = link.href.split('#')[0];
            const num = extractLeadingNumber(text);
            if (url) {
                lessons.push({ num, text, url });
            }
        });
        return lessons;
    }

    /**
     * Parsuje materiały z #matscroll na stronie lekcji.
     * Zwraca listę obiektów: { type: 'pdf'|'video', url, title, num, ext }
     *
     * Struktura DOM w #matscroll:
     *   <div.container-fluid>
     *     <h2.subheader>Materiały do tematu</h2>
     *     <div>  ← wspólny kontener wszystkich materiałów
     *       <p><b>1. Tytuł materiału</b></p>
     *       <div.course-material__progress-area ...>...</div>
     *       <div.pdf-container data-url="...">...</div>  ← PDF lub:
     *       <span data-id="...">...<video>...</video>...</span>  ← Video
     *     </div>
     *   </div>
     */
    function parseMaterialsFromDoc(doc) {
        const materials = [];
        const matscroll = doc.querySelector('#matscroll');
        if (!matscroll) return materials;

        let currentTitle = '';
        let currentNum = 0;

        // Pobieramy elementy w kolejności DOM: tytuły, pdf-container, kontenery wideo
        // querySelectorAll zachowuje kolejność dokumentu
        // Wideo są opakowane w <span data-id="..."> (zarówno w surowym HTML jak i po inicjalizacji VideoJS)
        // PDF-y w <div class="pdf-container" data-url="...">
        const elements = Array.from(
            matscroll.querySelectorAll('p > b, .pdf-container[data-url], span[data-id]')
        );

        for (const el of elements) {
            if (el.tagName === 'B' && el.parentElement && el.parentElement.tagName === 'P') {
                // Tytuł materiału
                const fullTitle = el.textContent.trim();
                currentNum = extractLeadingNumber(fullTitle) || (currentNum + 1);
                currentTitle = stripLeadingNumber(fullTitle);
            } else if (el.classList.contains('pdf-container') && el.dataset.url) {
                // PDF
                const url = el.dataset.url;
                const ext = url.split('.').pop().split('?')[0].toLowerCase() || 'pdf';
                materials.push({
                    type: 'pdf',
                    url,
                    title: currentTitle || 'materiał',
                    num: currentNum,
                    ext: ext === 'pdf' ? 'pdf' : 'pdf'
                });
            } else if (el.tagName === 'SPAN' && el.dataset.id) {
                // Kontener wideo – szukamy <source> na dowolnej głębokości (działa niezależnie
                // od tego czy VideoJS już zainicjalizował strukturę DOM czy nie)
                let sources = Array.from(el.querySelectorAll('source'));

                // Fallback: jeśli DOM nie zawiera <source> (źródła ładowane przez JS),
                // szukamy URL-i do ultracloud.pl bezpośrednio w innerHTML za pomocą regex
                if (sources.length === 0) {
                    const urlRegex = /https?:\/\/[^\s"']*ultracloud\.pl[^\s"']*\.(webm|mp4|mkv|avi|mov)[^\s"']*/gi;
                    const found = [];
                    let m;
                    while ((m = urlRegex.exec(el.innerHTML)) !== null) {
                        found.push({ getAttribute: () => m[0], src: m[0] });
                    }
                    sources = found;
                    if (found.length > 0) {
                        console.log('[MediaGrabber] Wideo znalezione przez regex fallback, data-id:', el.dataset.id);
                    } else {
                        console.warn('[MediaGrabber] Brak źródeł wideo dla span[data-id=' + el.dataset.id + ']');
                        continue;
                    }
                }

                // Wybieramy najniższą dostępną jakość
                const getSrc = (s) => (typeof s.getAttribute === 'function' ? s.getAttribute('src') : s.src) || '';
                const best =
                    sources.find((s) => getSrc(s).includes('_480')) ||
                    sources.find((s) => getSrc(s).includes('_720')) ||
                    sources.find((s) => getSrc(s).includes('_1080')) ||
                    sources[0];

                if (best) {
                    const srcUrl = getSrc(best);
                    if (!srcUrl) continue;
                    const extMatch = srcUrl.match(/\.(webm|mp4|avi|mov|mkv)(\?|$)/i);
                    const ext = extMatch ? extMatch[1].toLowerCase() : 'webm';
                    materials.push({
                        type: 'video',
                        url: srcUrl,
                        title: currentTitle || 'wideo',
                        num: currentNum,
                        ext
                    });
                }
            }
        }

        return materials;
    }

    // ===== GŁÓWNE SKANOWANIE =====

    async function scanAllMaterials(onStatus, isCancelled) {
        const allMaterials = [];

        // 1. Zbieramy przedmioty z bieżącej strony
        const subjects = parseSubjectsFromDoc(document);
        if (subjects.length === 0) {
            onStatus('❌ Nie znaleziono listy przedmiotów. Uruchom skrypt na stronie przedmiotu.');
            return allMaterials;
        }

        onStatus(`Znaleziono ${subjects.length} przedmiotów. Rozpoczynam skanowanie...`);

        for (let si = 0; si < subjects.length; si++) {
            if (isCancelled()) return allMaterials;

            const subject = subjects[si];
            onStatus(
                `Skanowanie przedmiotu ${si + 1}/${subjects.length}: ${subject.text.substring(0, 60)}...`
            );

            // 2. Pobieramy stronę przedmiotu, aby uzyskać listę lekcji
            let subjectDoc;
            try {
                const html = await fetchPage(subject.url);
                subjectDoc = parseHtml(html);
            } catch (e) {
                console.warn('[MediaGrabber] Błąd pobierania przedmiotu:', subject.url, e);
                onStatus(`⚠️ Pominięto przedmiot ${subject.num}: ${e.message}`);
                continue;
            }

            const lessons = parseLessonsFromDoc(subjectDoc);

            if (lessons.length === 0) {
                // Brak lekcji – może to przedmiot bez listy tematów
                // Sprawdzamy czy na stronie przedmiotu są bezpośrednie materiały
                const mats = parseMaterialsFromDoc(subjectDoc);
                mats.forEach((mat, mi) => {
                    allMaterials.push({
                        ...mat,
                        pp: subject.num,
                        tt: 1,
                        mm: mi + 1,
                        filename: buildFilename(subject.num, 1, mi + 1, mat.title, mat.ext)
                    });
                });
                continue;
            }

            // 3. Dla każdej lekcji pobieramy materiały
            for (let li = 0; li < lessons.length; li++) {
                if (isCancelled()) return allMaterials;

                const lesson = lessons[li];
                onStatus(
                    `Przedmiot ${si + 1}/${subjects.length}, lekcja ${li + 1}/${lessons.length}: ${lesson.text.substring(0, 50)}...`
                );

                // Opóźnienie, by nie bombardować serwera
                await new Promise((r) => setTimeout(r, 200));

                let lessonDoc;
                try {
                    const html = await fetchPage(lesson.url);
                    lessonDoc = parseHtml(html);
                } catch (e) {
                    console.warn('[MediaGrabber] Błąd pobierania lekcji:', lesson.url, e);
                    continue;
                }

                const mats = parseMaterialsFromDoc(lessonDoc);
                mats.forEach((mat, mi) => {
                    allMaterials.push({
                        ...mat,
                        pp: subject.num,
                        tt: lesson.num,
                        mm: mi + 1,
                        filename: buildFilename(subject.num, lesson.num, mi + 1, mat.title, mat.ext)
                    });
                });
            }
        }

        return allMaterials;
    }

    // ===== POBIERANIE =====

    /**
     * Pobiera plik przez GM_xmlhttpRequest (omija CORS, wysyła Referer) jako blob,
     * a następnie wyzwala pobieranie przez tymczasowy element <a>.
     * GM_download nie działa z tym CDN (zwraca 403 z kontekstu service-workera MV3).
     */
    function downloadFile(url, filename) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'blob',
                headers: {
                    'Referer': 'https://studia-online.pl/'
                },
                onload: (response) => {
                    if (response.status >= 200 && response.status < 400) {
                        try {
                            const blob = response.response;
                            const blobUrl = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = blobUrl;
                            a.download = filename;
                            a.style.display = 'none';
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
                            resolve({ ok: true });
                        } catch (e) {
                            console.warn('[MediaGrabber] Błąd zapisu blob:', filename, e);
                            resolve({ ok: false, err: e.message });
                        }
                    } else {
                        console.warn('[MediaGrabber] HTTP', response.status, 'dla:', filename);
                        resolve({ ok: false, err: `HTTP ${response.status}` });
                    }
                },
                onerror: (err) => {
                    console.warn('[MediaGrabber] Błąd pobierania:', filename, err);
                    resolve({ ok: false, err });
                },
                ontimeout: () => {
                    console.warn('[MediaGrabber] Timeout pobierania:', filename);
                    resolve({ ok: false, err: 'timeout' });
                }
            });
        });
    }

    async function downloadAll(materials, type, onStatus, isCancelled) {
        const filtered = materials.filter((m) => m.type === type);
        if (filtered.length === 0) {
            onStatus(`Brak plików typu ${type} do pobrania.`);
            return;
        }

        let success = 0;
        let failed = 0;

        for (let i = 0; i < filtered.length; i++) {
            if (isCancelled()) {
                onStatus(`⛔ Przerwano. Pobrano ${success} z ${filtered.length} plików.`);
                return;
            }
            const mat = filtered[i];
            onStatus(`Pobieranie ${i + 1}/${filtered.length}: ${mat.filename}`);
            const result = await downloadFile(mat.url, mat.filename);
            if (result && result.ok === false) {
                failed++;
            } else {
                success++;
            }
            await new Promise((r) => setTimeout(r, 400));
        }

        if (failed > 0) {
            onStatus(`✅ Pobrano ${success} plików. ❌ Błędy: ${failed}. Sprawdź konsolę (F12).`);
        } else {
            onStatus(`✅ Pobrano ${filtered.length} plików.`);
        }
    }

    // ===== FILTROWANIE =====

    /**
     * Parsuje tekst w formacie "1-4, 7, 10" na zbiór indeksów (1-based).
     * Zwraca null jeśli pole jest puste (brak filtra = pobierz wszystkie).
     */
    function parseRangeInput(text) {
        const trimmed = text.trim();
        if (!trimmed) return null;
        const indices = new Set();
        const parts = trimmed.split(/[,;]+/);
        for (const part of parts) {
            const rangMatch = part.trim().match(/^(\d+)-(\d+)$/);
            const singleMatch = part.trim().match(/^(\d+)$/);
            if (rangMatch) {
                const from = parseInt(rangMatch[1], 10);
                const to = parseInt(rangMatch[2], 10);
                for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
                    indices.add(i);
                }
            } else if (singleMatch) {
                indices.add(parseInt(singleMatch[1], 10));
            }
        }
        return indices.size > 0 ? indices : null;
    }

    // ===== INTERFEJS UŻYTKOWNIKA =====

    function createUI() {
        // Kontener główny
        const panel = document.createElement('div');
        panel.id = 'mg-panel';
        panel.style.cssText = [
            'position:fixed',
            'top:70px',
            'right:16px',
            'z-index:2147483647',
            'background:#1e1e2e',
            'color:#cdd6f4',
            'border-radius:12px',
            'padding:14px 16px',
            'width:310px',
            'font-family:Arial,sans-serif',
            'font-size:13px',
            'line-height:1.5',
            'box-shadow:0 6px 24px rgba(0,0,0,0.6)',
            'border:1px solid #45475a',
            'user-select:none'
        ].join(';');

        panel.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <span style="font-weight:bold;font-size:14px;color:#89b4fa">&#9660; MediaGrabber</span>
            <button id="mg-minimize" title="Minimalizuj" style="background:none;border:none;color:#6c7086;cursor:pointer;font-size:18px;line-height:1;padding:0 2px">&#8722;</button>
          </div>
          <div id="mg-body">
            <div id="mg-status" style="
              background:#181825;border-radius:6px;padding:8px 10px;margin-bottom:10px;
              min-height:40px;font-size:12px;color:#a6adc8;word-break:break-word;
              max-height:80px;overflow-y:auto;
            ">Kliknij &bdquo;Skanuj&rdquo;, aby zebrać listę wszystkich materiałów.</div>
            <button id="mg-scan" style="
              width:100%;padding:8px 0;margin-bottom:8px;
              background:#89b4fa;color:#1e1e2e;border:none;border-radius:6px;
              cursor:pointer;font-weight:bold;font-size:13px;
            ">&#128269; Skanuj materiały</button>
            <button id="mg-stop" style="
              width:100%;padding:8px 0;margin-bottom:8px;
              background:#f38ba8;color:#1e1e2e;border:none;border-radius:6px;
              cursor:pointer;font-weight:bold;font-size:13px;display:none;
            ">&#9632; Przerwij</button>
            <div style="display:flex;gap:6px;margin-bottom:6px">
              <button id="mg-dl-pdf" disabled style="
                flex:1;padding:8px 0;background:#a6e3a1;color:#1e1e2e;border:none;
                border-radius:6px;cursor:not-allowed;font-weight:bold;font-size:13px;opacity:0.4;
              ">&#128196; Pobierz PDF-y</button>
              <button id="mg-dl-video" disabled style="
                flex:1;padding:8px 0;background:#f38ba8;color:#1e1e2e;border:none;
                border-radius:6px;cursor:not-allowed;font-weight:bold;font-size:13px;opacity:0.4;
              ">&#127902; Pobierz Video</button>
            </div>
            <div id="mg-video-filter" style="display:none;margin-bottom:6px">
              <label style="font-size:11px;color:#a6adc8;display:block;margin-bottom:3px">Filtr wideo (np. <code style="color:#cba6f7">1-4, 7</code>) &ndash; puste = wszystkie:</label>
              <input id="mg-video-range" type="text" placeholder="np. 1-4, 7, 10" style="
                width:100%;box-sizing:border-box;padding:5px 8px;
                background:#181825;color:#cdd6f4;border:1px solid #45475a;
                border-radius:6px;font-size:12px;font-family:monospace;
              ">
              <div id="mg-video-range-hint" style="font-size:10px;color:#585b70;margin-top:2px"></div>
            </div>
            <div id="mg-stats" style="font-size:11px;color:#585b70;text-align:center"></div>
          </div>
        `;

        document.body.appendChild(panel);

        const statusEl = panel.querySelector('#mg-status');
        const scanBtn = panel.querySelector('#mg-scan');
        const stopBtn = panel.querySelector('#mg-stop');
        const dlPdfBtn = panel.querySelector('#mg-dl-pdf');
        const dlVideoBtn = panel.querySelector('#mg-dl-video');
        const statsEl = panel.querySelector('#mg-stats');
        const bodyEl = panel.querySelector('#mg-body');
        const minimizeBtn = panel.querySelector('#mg-minimize');
        const videoFilterEl = panel.querySelector('#mg-video-filter');
        const videoRangeInput = panel.querySelector('#mg-video-range');
        const videoRangeHint = panel.querySelector('#mg-video-range-hint');

        // Podgląd filtra na żywo
        videoRangeInput.addEventListener('input', () => {
            const indices = parseRangeInput(videoRangeInput.value);
            if (!indices) {
                videoRangeHint.textContent = 'Pobrane zostaną wszystkie filmy.';
            } else {
                const sorted = Array.from(indices).sort((a, b) => a - b);
                const total = allMaterials ? allMaterials.filter((m) => m.type === 'video').length : '?';
                videoRangeHint.textContent = `Wybrano numery: ${sorted.join(', ')} (z ${total} filmów)`;
            }
        });

        let cancelled = false;
        const isCancelled = () => cancelled;

        stopBtn.addEventListener('click', () => {
            cancelled = true;
            stopBtn.disabled = true;
            stopBtn.style.opacity = '0.5';
            stopBtn.textContent = '⏳ Przerywanie...';
        });

        function showStopButton() {
            cancelled = false;
            stopBtn.style.display = 'block';
            stopBtn.disabled = false;
            stopBtn.style.opacity = '1';
            stopBtn.textContent = '⏹ Przerwij';
        }

        function hideStopButton() {
            stopBtn.style.display = 'none';
        }

        let minimized = false;
        minimizeBtn.addEventListener('click', () => {
            minimized = !minimized;
            bodyEl.style.display = minimized ? 'none' : 'block';
            minimizeBtn.textContent = minimized ? '+' : '−';
        });

        // ---- Przycisk: Skanuj ----
        let allMaterials = null;

        function enableDownloadButtons() {
            const pdfCount = allMaterials ? allMaterials.filter((m) => m.type === 'pdf').length : 0;
            const videoCount = allMaterials ? allMaterials.filter((m) => m.type === 'video').length : 0;

            if (pdfCount > 0) {
                dlPdfBtn.disabled = false;
                dlPdfBtn.style.opacity = '1';
                dlPdfBtn.style.cursor = 'pointer';
                dlPdfBtn.textContent = `📄 Pobierz PDF-y (${pdfCount})`;
            }
            if (videoCount > 0) {
                dlVideoBtn.disabled = false;
                dlVideoBtn.style.opacity = '1';
                dlVideoBtn.style.cursor = 'pointer';
                dlVideoBtn.textContent = `🎬 Pobierz Video (${videoCount})`;
                videoFilterEl.style.display = 'block';
                videoRangeHint.textContent = 'Pobrane zostaną wszystkie filmy.';
            }
        }

        function disableButtons() {
            [scanBtn, dlPdfBtn, dlVideoBtn].forEach((btn) => {
                btn.disabled = true;
                btn.style.opacity = '0.5';
                btn.style.cursor = 'not-allowed';
            });
        }

        scanBtn.addEventListener('click', async () => {
            disableButtons();
            showStopButton();
            scanBtn.textContent = '⏳ Skanowanie...';
            statsEl.textContent = '';
            allMaterials = null;

            try {
                allMaterials = await scanAllMaterials((msg) => {
                    statusEl.textContent = msg;
                }, isCancelled);

                if (isCancelled()) {
                    const pdfCount = allMaterials.filter((m) => m.type === 'pdf').length;
                    const videoCount = allMaterials.filter((m) => m.type === 'video').length;
                    statusEl.textContent = `⛔ Skanowanie przerwane. Zebrano: PDF-y: ${pdfCount}, Filmy: ${videoCount}`;
                    statsEl.textContent = `Łącznie ${allMaterials.length} materiałów`;
                } else {
                    const pdfCount = allMaterials.filter((m) => m.type === 'pdf').length;
                    const videoCount = allMaterials.filter((m) => m.type === 'video').length;
                    statusEl.textContent = `✅ Skanowanie zakończone! PDF-y: ${pdfCount}, Filmy: ${videoCount}`;
                    statsEl.textContent = `Łącznie ${allMaterials.length} materiałów w ${pdfCount + videoCount > 0 ? '' : 'żadnym '}pliku`;
                }

                enableDownloadButtons();
            } catch (e) {
                statusEl.textContent = `❌ Błąd skanowania: ${e.message}`;
                console.error('[MediaGrabber] Błąd skanowania:', e);
            }

            hideStopButton();
            scanBtn.disabled = false;
            scanBtn.style.opacity = '1';
            scanBtn.style.cursor = 'pointer';
            scanBtn.textContent = '🔄 Skanuj ponownie';
        });

        // ---- Przycisk: Pobierz PDF-y ----
        dlPdfBtn.addEventListener('click', async () => {
            if (!allMaterials) return;
            disableButtons();
            showStopButton();
            await downloadAll(allMaterials, 'pdf', (msg) => {
                statusEl.textContent = msg;
            }, isCancelled);
            hideStopButton();
            scanBtn.disabled = false;
            scanBtn.style.opacity = '1';
            scanBtn.style.cursor = 'pointer';
            enableDownloadButtons();
        });

        // ---- Przycisk: Pobierz Video ----
        dlVideoBtn.addEventListener('click', async () => {
            if (!allMaterials) return;

            // Zastosuj filtr zakresu
            const rangeIndices = parseRangeInput(videoRangeInput.value);
            let videosToDownload = allMaterials.filter((m) => m.type === 'video');
            if (rangeIndices) {
                videosToDownload = videosToDownload.filter((_, i) => rangeIndices.has(i + 1));
                if (videosToDownload.length === 0) {
                    statusEl.textContent = '⚠️ Żaden film nie pasuje do podanego zakresu. Sprawdź filtr.';
                    return;
                }
            }

            disableButtons();
            showStopButton();
            statusEl.textContent = `⚠️ Uwaga: linki do filmów zawierają tokeny, które mogą wygasnąć. Pobieranie ${videosToDownload.length} filmów...`;
            await new Promise((r) => setTimeout(r, 1500));
            await downloadAll(videosToDownload, 'video', (msg) => {
                statusEl.textContent = msg;
            }, isCancelled);
            hideStopButton();
            scanBtn.disabled = false;
            scanBtn.style.opacity = '1';
            scanBtn.style.cursor = 'pointer';
            enableDownloadButtons();
        });
    }

    // ===== INICJALIZACJA =====
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createUI);
    } else {
        createUI();
    }
})();
