// ==UserScript==
// @name         MediaGrabber - Studia Online
// @namespace    https://studia-online.pl/
// @version      1.0.0
// @description  Pobiera materiały (PDF i wideo) z platformy studia-online.pl z automatycznym nazewnictwem PP.TT.MM
// @author       MediaGrabber
// @match        https://studia-online.pl/kurs/*
// @grant        GM_download
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

        // Pobieramy elementy w kolejności DOM: tytuły, pdf-container, video
        // querySelectorAll zachowuje kolejność dokumentu
        // video.video-js  – surowy HTML z serwera (przed inicjalizacją VideoJS)
        // video.vjs-tech  – przetworzone DOM na bieżącej stronie (po inicjalizacji VideoJS)
        const elements = Array.from(
            matscroll.querySelectorAll('p > b, .pdf-container[data-url], video.video-js, video.vjs-tech')
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
            } else if (el.tagName === 'VIDEO') {
                // Wideo – wybieramy najniższą dostępną jakość
                const sources = Array.from(el.querySelectorAll('source'));
                if (sources.length === 0) continue;

                const best =
                    sources.find((s) => s.src.includes('_480')) ||
                    sources.find((s) => s.src.includes('_720')) ||
                    sources.find((s) => s.src.includes('_1080')) ||
                    sources[0];

                if (best && best.src) {
                    const srcUrl = best.src;
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

    async function scanAllMaterials(onStatus) {
        const allMaterials = [];

        // 1. Zbieramy przedmioty z bieżącej strony
        const subjects = parseSubjectsFromDoc(document);
        if (subjects.length === 0) {
            onStatus('❌ Nie znaleziono listy przedmiotów. Uruchom skrypt na stronie przedmiotu.');
            return allMaterials;
        }

        onStatus(`Znaleziono ${subjects.length} przedmiotów. Rozpoczynam skanowanie...`);

        for (let si = 0; si < subjects.length; si++) {
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

    function downloadFile(url, filename) {
        return new Promise((resolve) => {
            GM_download({
                url: url,
                name: filename,
                saveAs: false,
                onload: () => resolve({ ok: true }),
                onerror: (err) => {
                    console.warn('[MediaGrabber] Błąd pobierania:', filename, err);
                    resolve({ ok: false, err });
                },
                ontimeout: () => {
                    console.warn('[MediaGrabber] Timeout pobierania:', filename);
                    resolve({ ok: false, err: 'timeout' });
                }
            });
            // Krókie opóźnienie między plikami, by przeglądarka uruchomiła pobieranie
            setTimeout(resolve, 800);
        });
    }

    async function downloadAll(materials, type, onStatus) {
        const filtered = materials.filter((m) => m.type === type);
        if (filtered.length === 0) {
            onStatus(`Brak plików typu ${type} do pobrania.`);
            return;
        }

        let success = 0;
        let failed = 0;

        for (let i = 0; i < filtered.length; i++) {
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
            <div id="mg-stats" style="font-size:11px;color:#585b70;text-align:center"></div>
          </div>
        `;

        document.body.appendChild(panel);

        const statusEl = panel.querySelector('#mg-status');
        const scanBtn = panel.querySelector('#mg-scan');
        const dlPdfBtn = panel.querySelector('#mg-dl-pdf');
        const dlVideoBtn = panel.querySelector('#mg-dl-video');
        const statsEl = panel.querySelector('#mg-stats');
        const bodyEl = panel.querySelector('#mg-body');
        const minimizeBtn = panel.querySelector('#mg-minimize');

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
            scanBtn.textContent = '⏳ Skanowanie...';
            statsEl.textContent = '';
            allMaterials = null;

            try {
                allMaterials = await scanAllMaterials((msg) => {
                    statusEl.textContent = msg;
                });

                const pdfCount = allMaterials.filter((m) => m.type === 'pdf').length;
                const videoCount = allMaterials.filter((m) => m.type === 'video').length;

                statusEl.textContent = `✅ Skanowanie zakończone! PDF-y: ${pdfCount}, Filmy: ${videoCount}`;
                statsEl.textContent = `Łącznie ${allMaterials.length} materiałów w ${pdfCount + videoCount > 0 ? '' : 'żadnym '}pliku`;

                enableDownloadButtons();
            } catch (e) {
                statusEl.textContent = `❌ Błąd skanowania: ${e.message}`;
                console.error('[MediaGrabber] Błąd skanowania:', e);
            }

            scanBtn.disabled = false;
            scanBtn.style.opacity = '1';
            scanBtn.style.cursor = 'pointer';
            scanBtn.textContent = '🔄 Skanuj ponownie';
        });

        // ---- Przycisk: Pobierz PDF-y ----
        dlPdfBtn.addEventListener('click', async () => {
            if (!allMaterials) return;
            disableButtons();
            await downloadAll(allMaterials, 'pdf', (msg) => {
                statusEl.textContent = msg;
            });
            scanBtn.disabled = false;
            scanBtn.style.opacity = '1';
            scanBtn.style.cursor = 'pointer';
            enableDownloadButtons();
        });

        // ---- Przycisk: Pobierz Video ----
        dlVideoBtn.addEventListener('click', async () => {
            if (!allMaterials) return;
            disableButtons();
            statusEl.textContent =
                '⚠️ Uwaga: linki do filmów zawierają tokeny, które mogą wygasnąć. Pobieranie...';
            await new Promise((r) => setTimeout(r, 1500));
            await downloadAll(allMaterials, 'video', (msg) => {
                statusEl.textContent = msg;
            });
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
