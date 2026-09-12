// Seeded input corpus shared by the JS runner and the independent Go oracle.
export const SEED = 0x6d2b79f5;
export function matcherCases(count = 5000) {
  let state = SEED;
  const next = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return state >>> 0;
  };
  const pick = (items) => items[next() % items.length];
  const atoms = [
    ['a', 'a'], ['b', 'b'], ['/', '/'], ['.', '.'], ['^', '^'], [']', ']'],
    ['\u00e9', '\u00e9'], ['\u{1f600}', '\u{1f600}'], ['?', '\u{1f600}'], ['*', 'ab'],
    ['[a-z]', 'm'], ['[^a-z]', '\u00e9'], ['[!]', '!'], ['[[]', '['],
    ['\\*', '*'], ['\\?', '?'], ['[\\]]', ']'],
  ];
  const copy = [
    ['[^a]', '/'], ['[/]', '/'], ['a]', 'a]'], ['^*', '^name'],
    ['[[]', '['], ['[a-z]', 'm'], ['a\\', 'a'], ['[', 'x'],
    ['*.txt', 'x.txt\n'], ['?*', '\u{1f600}'], ['*', ''],
  ].map(([pattern, path]) => ({ kind: 'copy', pattern, path }));
  for (let i = 0; i < count; i++) {
    let pattern = '', pathname = '';
    const size = 1 + next() % 6;
    for (let j = 0; j < size; j++) {
      const [token, value] = pick(atoms);
      pattern += token; pathname += value;
    }
    if (next() % 3 === 0) pathname = pick(['x', '/', '\n', '\u00e9']) + pathname;
    if (next() % 5 === 0) pattern += pick(['[', '\\', '[-]', '[a-]']);
    copy.push({ kind: 'copy', pattern, path: pathname });
  }
  const ignore = [
    ['^*', '^name'], ['a]', 'a]'], ['[[]', '['], ['*.txt', 'x.txt\n'],
    ['**/*.txt', 'dir\n/x.txt'], ['**/*.txt', 'dir\r/x.txt'],
    ['**/*.txt', 'dir\u2028/x.txt'], ['**/*.txt', 'dir\u2029/x.txt'], ['[a-z]', 'm'], ['**\n!dir\ndir/private', 'dir/private/file'],
    ['a\\\\', 'a\\'], ['\\!name', '!name'], ['\\#name', '#name'],
    ['\uFEFF# comment\r\n*.txt\r\n!a.txt', 'a.txt'],
  ].map(([pattern, path]) => ({ kind: 'ignore', pattern, path }));
  const rules = ['**', '*', '?', '[a-z]', '[^a-z]', '[!]', '[[]', ']', '^*',
    'src/**', '**/src', '**/*.txt', 'a*.txt', '*.txt', '\u00e9', '\u{1f600}',
    'src/a', 'a]', 'a\\\\', '\\!name', '\\#name', '[', '!', '[a-]', '# comment'];
  const paths = ['a', 'b', 'src/a', 'src/private/a.txt', 'a.txt', 'x.txt\n',
    'dir\n/x.txt', '^name', 'a]', '[', '!', '\u00e9', '\u{1f600}', 'a\\', '!name', '#name'];
  for (let i = 0; i < count; i++) {
    const sequence = [];
    for (let j = 0, n = 1 + next() % 4; j < n; j++) sequence.push((next() % 3 ? '' : '!') + pick(rules));
    ignore.push({ kind: 'ignore', pattern: sequence.join('\n'), path: pick(paths) });
  }
  return [...copy, ...ignore];
}
