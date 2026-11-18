import { useRef, useState } from "react";
import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import { createWorker } from "tesseract.js";

// Loaded from a CDN so it works regardless of bundler (Vite/CRA/etc).
// Swap for a locally-bundled worker file later if you'd rather not depend on the CDN.
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

// The ID is on the "Sub ..." line under the address in the title block,
// in the right-hand panel of each landscape plan. Search region, as a
// fraction of the page width/height (measured from the top-left).
const ID_REGION_LEFT = 0.78;   // right-hand panel
const ID_REGION_TOP = 0.30;
const ID_REGION_BOTTOM = 0.75;
const RENDER_SCALE = 3;        // higher render resolution = better OCR accuracy
// Windows filenames can't contain "/", so it's swapped for this in the filename.
const SLASH_REPLACEMENT = "-";

// The ID is everything after "Sub" on the last line that starts with "Sub",
// including anything after a "/", e.g. "Sub 7113P" -> "7113P".
function findId(text) {
    if (!text) return null;
    const matches = [...text.matchAll(/^\s*Sub\b\s*(\S.*?)\s*$/gm)];
    if (matches.length === 0) return null;
    return matches[matches.length - 1][1].replace(/\s+/g, " ") || null;
}

// Reads the ID from the title block of `pageNumber` (1-indexed).
// Tries the PDF's own text first (exact, instant); if the page is a scan with
// no text layer, renders the title block and OCRs it instead.
// Returns { id, rawText, source }.
async function extractIdFromPage(pdfBytes, pageNumber, getOcrWorker) {
    // pdf.js transfers ownership of the typed array it's given to its worker
    // thread, which detaches the underlying buffer. Pass a copy so the
    // original bytes (still needed for saving the PDF) stay intact.
    const pdf = await pdfjsLib.getDocument({ data: pdfBytes.slice() }).promise;
    if (pageNumber > pdf.numPages) return { id: null, rawText: "", source: null };

    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });

    // 1) Text layer: collect text in the title block, grouped into lines.
    const content = await page.getTextContent();
    const blockItems = [];
    content.items.forEach((item) => {
        if (!item.str || !item.str.trim()) return;
        const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
        if (x >= viewport.width * ID_REGION_LEFT && y >= viewport.height * ID_REGION_TOP && y <= viewport.height * ID_REGION_BOTTOM) {
            blockItems.push({ x, y, str: item.str });
        }
    });
    blockItems.sort((a, b) => (Math.abs(a.y - b.y) > 2 ? a.y - b.y : a.x - b.x));
    const lines = [];
    blockItems.forEach((item) => {
        const line = lines[lines.length - 1];
        if (line && Math.abs(line.y - item.y) <= 2) line.text += item.str;
        else lines.push({ y: item.y, text: item.str });
    });
    const blockText = lines.map((line) => line.text).join("\n");
    const textId = findId(blockText);
    if (textId) return { id: textId, rawText: blockText, source: "text" };

    // 2) OCR fallback for scanned pages: OCR the title-block region.
    const renderViewport = page.getViewport({ scale: RENDER_SCALE });
    const pageCanvas = document.createElement("canvas");
    pageCanvas.width = renderViewport.width;
    pageCanvas.height = renderViewport.height;
    await page.render({ canvasContext: pageCanvas.getContext("2d"), viewport: renderViewport }).promise;

    const left = Math.floor(renderViewport.width * ID_REGION_LEFT);
    const top = Math.floor(renderViewport.height * ID_REGION_TOP);
    const width = Math.floor(renderViewport.width) - left;
    const height = Math.floor(renderViewport.height * ID_REGION_BOTTOM) - top;

    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = width;
    cropCanvas.height = height;
    const ctx = cropCanvas.getContext("2d");
    ctx.drawImage(pageCanvas, left, top, width, height, 0, 0, width, height);

    // Keep red and dark text, wash out light-grey map lines, so OCR sees
    // black text on white.
    const image = ctx.getImageData(0, 0, width, height);
    const px = image.data;
    for (let i = 0; i < px.length; i += 4) {
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const isRed = r > 120 && r - Math.max(g, b) > 60;
        const isDark = 0.299 * r + 0.587 * g + 0.114 * b < 110;
        const v = isRed || isDark ? 0 : 255;
        px[i] = px[i + 1] = px[i + 2] = v;
    }
    ctx.putImageData(image, 0, 0);

    const blob = await new Promise((resolve) => cropCanvas.toBlob(resolve, "image/png"));
    if (!blob) return { id: null, rawText: blockText, source: null };

    try {
        const ocrWorker = await getOcrWorker();
        const { data: { text } } = await ocrWorker.recognize(blob);
        return { id: findId(text), rawText: text || "", source: "ocr" };
    }
    catch (error) {
        console.warn(`OCR failed for page ${pageNumber}:`, error);
        return { id: null, rawText: blockText, source: null };
    }
}

function PdfSplitter() {
    const splitInputRef = useRef(null);
    const [ocrResults, setOcrResults] = useState([]);
    const [isSplitting, setIsSplitting] = useState(false);
    const [splitArea, setSplitArea] = useState("");

    function sanitizeFilename(name) {
        if (!name) return null;
        let s = name.replace(/[<>:\"/\\|?*\x00-\x1F]/g, "");
        s = s.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
        s = s.replace(/[.\s]+$/g, "");
        return s || null;
    }

    // Builds "[Area] Feeder - TX [ID]". "/" in the ID is swapped out
    // because it isn't allowed in filenames.
    function buildFeederPlanFilename(area, id) {
        if (!id) return null;
        return sanitizeFilename(`${area} Feeder - TX ${id.replace(/\//g, SLASH_REPLACEMENT)}`);
    }

    function downloadBlob(bytes, filename) {
        const blob = new Blob([bytes], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${filename}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    async function requestWritePermission(folderHandle) {
        if (!folderHandle) return false;

        try {
            if (typeof folderHandle.requestPermission === "function") {
                const perm = await folderHandle.requestPermission({ mode: "readwrite" });
                return perm === "granted";
            }
            if (typeof folderHandle.queryPermission === "function") {
                let permission = await folderHandle.queryPermission({ mode: "readwrite" });
                if (permission !== "granted") {
                    permission = await folderHandle.requestPermission({ mode: "readwrite" });
                }
                return permission === "granted";
            }
        }
        catch (error) {
            console.warn("Write permission error:", error);
        }

        return false;
    }

    // Save bytes to the provided folderHandle when available, otherwise
    // prompt the user for a folder once (when savePdf is called without a handle).
    // Pass `subfolderName` to save inside a subfolder of the chosen folder
    // (created if it doesn't exist).
    async function savePdf(bytes, filename, folderHandle = null, subfolderName = null) {
        let useDirectorySave = false;
        let handle = folderHandle;

        if (!handle) {
            // fall back to prompting the user (legacy behavior)
            handle = await window.showDirectoryPicker();
        }

        useDirectorySave = await requestWritePermission(handle).catch(() => false);

        if (useDirectorySave) {
            try {
                const targetHandle = subfolderName
                    ? await handle.getDirectoryHandle(subfolderName, { create: true })
                    : handle;
                const fileHandle = await targetHandle.getFileHandle(`${filename}.pdf`, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(bytes);
                await writable.close();
                return true;
            }
            catch (error) {
                console.warn("Directory save failed:", error);
            }
        }

        downloadBlob(bytes, filename);
        return false;
    }

    async function splitPdf() {
        const file = splitInputRef.current.files[0];

        if (!file) {
            alert("Select a PDF to split first.");
            return;
        }

        const area = splitArea.trim();
        if (!area) {
            alert("Enter the Area first.");
            return;
        }

        setOcrResults([]);
        setIsSplitting(true);

        const pdfBytes = await file.arrayBuffer();
        const sourcePdf = await PDFDocument.load(pdfBytes);
        const pageCount = sourcePdf.getPageCount();

        // prompt once for a save directory and reuse it for all chunks
        let folderHandle = null;
        try {
            folderHandle = await window.showDirectoryPicker();
            const granted = await requestWritePermission(folderHandle).catch(() => false);
            if (!granted) folderHandle = null;
        }
        catch (e) {
            folderHandle = null;
        }

        // One OCR worker, only started if a page has no readable text layer,
        // reused across every chunk and terminated once the loop finishes.
        let ocrWorkerPromise = null;
        const getOcrWorker = () => {
            if (!ocrWorkerPromise) ocrWorkerPromise = createWorker("eng");
            return ocrWorkerPromise;
        };

        let fileNumber = 1;
        let successCount = 0;
        // Filenames already used in this run, so two pages that OCR to the same
        // App Number/Address don't overwrite each other.
        const usedFilenames = new Set();
        let failureCount = 0;

        for (let i = 0; i < pageCount; i++) {
            const chunkNumber = fileNumber;
            let outputBytes;

            try {
                const newPdf = await PDFDocument.create();
                const pages = await newPdf.copyPages(sourcePdf, [i]);
                pages.forEach((page) => newPdf.addPage(page));
                outputBytes = await newPdf.save();
            }
            catch (error) {
                console.error("Failed to build PDF chunk", chunkNumber, error);
                failureCount++;
                fileNumber++;
                continue;
            }

            let idResult = { id: null, rawText: "", source: null };
            try {
                idResult = await extractIdFromPage(outputBytes, 1, getOcrWorker);
            }
            catch (error) {
                console.warn("ID read failed for chunk", chunkNumber, error);
            }

            const parsedFilename = buildFeederPlanFilename(area, idResult.id);
            const baseFilename = parsedFilename || sanitizeFilename(`${area} Feeder - Document ${chunkNumber}`) || `Document ${chunkNumber}`;
            let filename = baseFilename;
            for (let copy = 2; usedFilenames.has(filename.toLowerCase()); copy++) {
                filename = `${baseFilename} (${copy})`;
            }
            usedFilenames.add(filename.toLowerCase());
            if (!parsedFilename) {
                console.warn(`Chunk ${chunkNumber}: couldn't find a "Sub" line, using fallback name.`);
            }

            setOcrResults((current) => [
                ...current,
                { chunkNumber, filename, id: idResult.id, ocrText: idResult.rawText || "", usedFallback: !parsedFilename }
            ]);

            try {
                if (folderHandle) {
                    await savePdf(outputBytes, filename, folderHandle);
                }
                else {
                    // user didn't choose a folder (or permission denied) — download
                    downloadBlob(outputBytes, filename);
                }

                successCount++;
            }
            catch (error) {
                console.error("Save failed for chunk", chunkNumber, error);
                failureCount++;
            }

            fileNumber++;
        }

        if (ocrWorkerPromise) {
            try { await (await ocrWorkerPromise).terminate(); }
            catch (error) { console.warn("Couldn't stop OCR worker", error); }
        }
        setIsSplitting(false);

        alert(`Finished. ${successCount} files saved, ${failureCount} failures.`);
    }

    return (
        <>
            <h2>PDF Splitter</h2>

            <section style={{ marginBottom: '20px' }}>
                <input type="file" accept=".pdf" ref={splitInputRef} />
                <br />
                <br />
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                    Area
                    <input
                        type="text"
                        value={splitArea}
                        onChange={(event) => setSplitArea(event.target.value)}
                        placeholder="e.g. Kelvin Grove"
                        style={{ padding: '8px 10px', border: '1px solid #ccc', borderRadius: '6px', fontSize: '14px', minWidth: '220px' }}
                    />
                </label>
                <p style={{ margin: '6px 0 0', color: '#666', fontSize: '13px' }}>
                    Files save as "{splitArea.trim() || "[Area]"} Feeder - TX [ID]"
                </p>
                <br />
                <button onClick={splitPdf} disabled={isSplitting}>
                    {isSplitting ? "Splitting…" : "Split PDF"}
                </button>

                {ocrResults.length > 0 && (() => {
                    const fallbackResults = ocrResults.filter((result) => result.usedFallback);
                    if (fallbackResults.length === 0) return null;

                    return (
                        <div style={{ marginTop: '20px' }}>
                            <strong>Chunks that couldn't be auto-named ({fallbackResults.length})</strong>
                            <p style={{ margin: '4px 0 8px', color: '#666' }}>
                                These fell back to "Document N" because no line starting with "Sub" was found
                                in the title block. Check the text below and rename manually if needed.
                            </p>
                            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '8px' }}>
                                <thead>
                                    <tr>
                                        <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '6px' }}>Chunk</th>
                                        <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '6px' }}>Filename used</th>
                                        <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '6px' }}>Title block text read</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {fallbackResults.map((result) => (
                                        <tr key={result.chunkNumber}>
                                            <td style={{ borderBottom: '1px solid #eee', padding: '6px', verticalAlign: 'top' }}>
                                                {result.chunkNumber}
                                            </td>
                                            <td style={{ borderBottom: '1px solid #eee', padding: '6px', verticalAlign: 'top', color: '#b45309' }}>
                                                {result.filename}
                                            </td>
                                            <td style={{ borderBottom: '1px solid #eee', padding: '6px', verticalAlign: 'top', whiteSpace: 'pre-wrap', color: result.ocrText ? '#000' : '#999' }}>
                                                {result.ocrText || "(no text detected)"}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    );
                })()}
            </section>
        </>
    );
}

export default PdfSplitter;