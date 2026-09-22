type Vec = [number, number, number];
type Triangle = { a: Vec; b: Vec; c: Vec; denominator: number };

export function worldCollisionSampler(dump: string): (x: number, y: number, height: number) => number | null {
  const groups = [...dump.matchAll(/m_nCollisionAttributeIndex = (\d+)[\s\S]*?m_Mesh\s*=/g)].map(match => match[1]);
  if (groups.join(',') !== '0,1,2,3' || !dump.includes('m_CollisionGroupString = "default"')) {
    throw new Error('Expected the four inspected world collision meshes in their original order');
  }
  // Extract only self-contained hex blobs, not KV3 structure. The source archive is pinned by the caller.
  function blobs(field: string): Buffer[] {
    const result = [...dump.matchAll(new RegExp(`${field}\\s*=\\s*#\\[([^\\]]*)\\]`, 'g'))].map(match => {
      if (/[^0-9a-fA-F\s]/.test(match[1])) throw new Error(`Invalid physics hex blob: ${field}`);
      const hex = match[1].replace(/\s/g, '');
      if (hex.length % 2) throw new Error(`Truncated physics hex blob: ${field}`);
      return Buffer.from(hex, 'hex');
    });
    if (result.length !== 4) throw new Error('Expected the four inspected world collision groups');
    return result;
  }
  const vertices = blobs('m_Vertices')[0], indices = blobs('m_Triangles')[0];
  if (vertices.length % 12 || indices.length % 12) throw new Error('Invalid collision buffer stride');
  const points: Vec[] = [];
  for (let offset = 0; offset < vertices.length; offset += 12) {
    const point: Vec = [vertices.readFloatLE(offset), vertices.readFloatLE(offset + 4), vertices.readFloatLE(offset + 8)];
    if (point.some(value => !Number.isFinite(value) || Math.abs(value) > 20000)) throw new Error('Invalid world collision vertex');
    points.push(point);
  }
  const buckets = new Map<string, Triangle[]>();
  for (let offset = 0; offset < indices.length; offset += 12) {
    const a = points[indices.readUInt32LE(offset)], b = points[indices.readUInt32LE(offset + 4)], c = points[indices.readUInt32LE(offset + 8)];
    if (!a || !b || !c) throw new Error('World collision triangle index outside vertex buffer');
    const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(denominator) < 1e-8) continue;
    const triangle = { a, b, c, denominator };
    const minX = Math.floor(Math.min(a[0], b[0], c[0]) / 128), maxX = Math.floor(Math.max(a[0], b[0], c[0]) / 128);
    const minY = Math.floor(Math.min(a[1], b[1], c[1]) / 128), maxY = Math.floor(Math.max(a[1], b[1], c[1]) / 128);
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const key = `${x},${y}`, bucket = buckets.get(key);
      if (bucket) bucket.push(triangle);
      else buckets.set(key, [triangle]);
    }
  }
  return (x, y, height) => {
    if (![x, y, height].every(Number.isFinite)) throw new Error('Collision sample values must be finite');
    let closest: number | null = null;
    for (const { a, b, c, denominator } of buckets.get(`${Math.floor(x / 128)},${Math.floor(y / 128)}`) ?? []) {
      const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / denominator;
      const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / denominator;
      if (u < -1e-6 || v < -1e-6 || u + v > 1.000001) continue;
      const candidate = u * a[2] + v * b[2] + (1 - u - v) * c[2];
      if (closest === null || Math.abs(candidate - height) < Math.abs(closest - height)) closest = candidate;
    }
    return closest;
  };
}
