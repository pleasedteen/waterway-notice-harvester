/**
 * 表格网格构建：处理跨行(rowspan)/跨列(colspan)、重复表头、脏 HTML。
 * 输出 rows[r][c]：r 为逻辑行号（0 基），c 为逻辑列号（0 基），空格为 null。
 * 被 span 覆盖的格子保持对源单元格的引用（spanned=true）。
 */
export interface GridCell {
  text: string;
  /** 源 tr 序号（1 基） */
  sourceRow: number;
  /** 源 td/th 序号（1 基） */
  sourceCol: number;
  isHeader: boolean;
  /** 该格是被 rowspan/colspan 扩展出来的占位 */
  spanned: boolean;
  el: unknown;
}

export interface TableGrid {
  /** 逻辑行（0 基），每行按逻辑列号排列，空位为 null */
  rows: (GridCell | null)[][];
  /** 有效表头行数：声明值与"连续全 th 行"检测值取小，兼容单/双行表头与续页无表头 */
  headerRowCount: number;
  /** 每个逻辑行对应的源 tr 序号（1 基），用于证据定位 */
  trIndex: number[];
  /** 该行是否为续表重复表头（数据迭代时跳过，但仍可用于列名解析） */
  repeatedHeader: boolean[];
}

interface RawCell {
  text: string;
  rowspan: number;
  colspan: number;
  isHeader: boolean;
  trIndex: number;
  colIndex: number;
  el: unknown;
}

interface TableLike {
  querySelectorAll(sel: string): ElementLike[];
}

interface ElementLike {
  tagName?: string;
  textContent?: string;
  getAttribute?(name: string): string | undefined;
  querySelectorAll?(sel: string): ElementLike[];
}

function intSpan(v: string | undefined): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

/**
 * 构建网格。repeatHeaderMarkers 命中的逻辑行会被剔除（续表重复表头），
 * 但占位 span 的传播在剔除前完成，保证列不错位。
 */
export function buildGrid(table: TableLike, headerRows: number, repeatHeaderMarkers: string[]): TableGrid {
  const trs = table.querySelectorAll('tr');
  const rawRows: RawCell[][] = [];
  trs.forEach((tr, trIdx) => {
    const cells = tr.querySelectorAll?.('th,td') ?? [];
    if (cells.length === 0) return;
    const row: RawCell[] = [];
    let colIdx = 0;
    for (const cell of cells) {
      colIdx += 1;
      row.push({
        text: cell.textContent ?? '',
        rowspan: intSpan(cell.getAttribute?.('rowspan')),
        colspan: intSpan(cell.getAttribute?.('colspan')),
        isHeader: (cell.tagName ?? '').toLowerCase() === 'th',
        trIndex: trIdx + 1,
        colIndex: colIdx,
        el: cell,
      });
    }
    rawRows.push(row);
  });

  // 展开 span 到二维矩阵（保持逻辑列号，空位为 null）
  const matrix: (GridCell | null)[][] = [];
  const trIndex: number[] = [];
  rawRows.forEach((rawRow, r) => {
    if (!matrix[r]) matrix[r] = [];
    trIndex[r] = rawRow[0]?.trIndex ?? r + 1;
    let cursor = 0;
    for (const cell of rawRow) {
      while (matrix[r][cursor]) cursor += 1;
      for (let dr = 0; dr < cell.rowspan; dr += 1) {
        const rr = r + dr;
        if (!matrix[rr]) matrix[rr] = [];
        if (trIndex[rr] === undefined) trIndex[rr] = cell.trIndex;
        for (let dc = 0; dc < cell.colspan; dc += 1) {
          const cc = cursor + dc;
          matrix[rr][cc] = {
            text: cell.text,
            sourceRow: cell.trIndex,
            sourceCol: cell.colIndex,
            isHeader: cell.isHeader,
            spanned: dr !== 0 || dc !== 0,
            el: cell.el,
          };
        }
      }
      cursor += cell.colspan;
    }
  });

  // 标记重复表头行（保留在网格中用于列名解析，数据迭代时跳过）
  const rows: (GridCell | null)[][] = [];
  const keptTrIndex: number[] = [];
  const repeatedHeader: boolean[] = [];
  for (let r = 0; r < matrix.length; r += 1) {
    const row = matrix[r]!;
    const cells = row.filter((c): c is GridCell => c !== null);
    const isRepeat = cells.some((c) => repeatHeaderMarkers.some((m) => c.text.includes(m)));
    repeatedHeader.push(isRepeat);
    rows.push(row);
    keptTrIndex.push(trIndex[r] ?? r + 1);
  }

  // 检测连续的全 th 行作为实际表头；与声明表头行数取小
  let detected = 0;
  while (
    detected < rows.length &&
    rows[detected]!.filter((c): c is GridCell => c !== null).every((c) => c.isHeader)
  ) {
    detected += 1;
  }
  const effectiveHeader = Math.min(headerRows, detected);

  return { rows, headerRowCount: effectiveHeader, trIndex: keptTrIndex, repeatedHeader };
}

/**
 * 由前 headerRowCount 行组合列名（跨行表头按空格拼接），返回 逻辑列号(0基)->字段名。
 * columns 的 key 在组合列名中做包含匹配；未命中列不产出。
 */
export function resolveColumns(
  grid: TableGrid,
  columns: Record<string, string>,
): Map<number, string> {
  const result = new Map<number, string>();
  const maxCol = Math.max(...grid.rows.slice(0, grid.headerRowCount).map((r) => r.length), 0);
  for (let col = 0; col < maxCol; col += 1) {
    const headerParts: string[] = [];
    for (let hr = 0; hr < grid.headerRowCount; hr += 1) {
      const cell = grid.rows[hr]?.[col];
      if (cell && !cell.spanned) headerParts.push(cell.text.replace(/\s+/g, ' ').trim());
    }
    const header = headerParts.join(' ').replace(/\s+/g, ' ').trim();
    for (const [marker, fieldName] of Object.entries(columns)) {
      if (header.includes(marker)) {
        result.set(col, fieldName);
        break;
      }
    }
  }
  return result;
}
