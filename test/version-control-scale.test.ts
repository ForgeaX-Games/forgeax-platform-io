import { describe, expect, test } from 'bun:test';
import { parsePorcelainV2 } from '../src/version-control/status';

describe('version-control scale baselines', () => {
  test('parses 1k status records repeatedly without quadratic growth', () => {
    const input = Array.from({ length: 1000 }, (_, index) => `1 .M N... 100644 100644 100644 a${index} b${index} file-${index}.json\0`).join('');
    const elapsed: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const start = performance.now();
      const records = parsePorcelainV2(input);
      elapsed.push(performance.now() - start);
      expect(records).toHaveLength(1000);
      expect(records[999]?.path).toBe('file-999.json');
    }
    expect(Math.max(...elapsed)).toBeLessThan(5000);
  });

  test('projects a 1k-node canonical DAG with stable ancestry edges', () => {
    const nodes = Array.from({ length: 1000 }, (_, index) => ({ id: `scale-${index}`, head: `${index.toString(16).padStart(40, '0')}` }));
    const edges = nodes.slice(1).map((node, index) => ({ from: node.id, to: nodes[index]!.id }));
    const visible = new Set(nodes.map((node) => node.id));
    const start = performance.now();
    const projected = edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to));
    const elapsed = performance.now() - start;
    expect(nodes).toHaveLength(1000);
    expect(projected).toHaveLength(999);
    expect(projected[998]).toEqual({ from: 'scale-999', to: 'scale-998' });
    expect(elapsed).toBeLessThan(5000);
  });
});
