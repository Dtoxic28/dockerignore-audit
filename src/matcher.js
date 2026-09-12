import path from 'node:path';

const REGEXP_SPECIAL = /[.+()|{}$]/;
const WINDOWS = process.platform === 'win32';

export function compileDockerIgnore(source, sourceName) {
  const rules = [];
  const diagnostics = [];
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    try {
      const parsed = parseRule(raw);
      if (!parsed) continue;
      const matchesPath = compilePattern(parsed.pattern);
      rules.push({
        line: index + 1,
        pattern: parsed.pattern,
        negative: parsed.negative,
        matchesPath,
        appliesTo: (pathname) => matchesOrParent(matchesPath, cleanTarget(pathname)),
        matches: 0,
        effects: 0,
      });
    } catch (error) {
      diagnostics.push({
        code: 'invalid-rule',
        severity: 'error',
        message: error.message,
        source: sourceName,
        line: index + 1,
        column: 1,
      });
    }
  }

  return {
    rules,
    diagnostics,
    matcher: {
      ignores(pathname) {
        return evaluateIgnoreRules(rules, pathname).ignored;
      },
    },
  };
}

export function evaluateIgnoreRules(rules, pathname) {
  const target = cleanTarget(pathname);
  if (target === '.') return { ignored: false, rule: undefined };

  let ignored = false;
  let rule;
  for (const candidate of rules) {
    if (candidate.negative !== ignored || !candidate.appliesTo(target)) continue;
    ignored = !candidate.negative;
    rule = candidate;
  }
  return { ignored, rule };
}

export function matchFilePattern(pattern, pathname, options = {}) {
  const tokens = tokenizeFilePattern(pattern, options.globstar === true);
  const characters = [...pathname];
  const memo = new Map();

  function matches(patternIndex, pathIndex) {
    const key = `${patternIndex}:${pathIndex}`;
    if (memo.has(key)) return memo.get(key);

    let result;
    const token = tokens[patternIndex];
    if (!token) {
      result = pathIndex === characters.length;
    } else if (token.type === 'star') {
      result = matches(patternIndex + 1, pathIndex);
      for (let index = pathIndex; !result && index < characters.length && characters[index] !== '/'; index += 1) {
        result = matches(patternIndex + 1, index + 1);
      }
    } else if (token.type === 'globstar') {
      const next = tokens[patternIndex + 1];
      if (next?.type === 'literal' && next.value === '/') {
        result = matches(patternIndex + 2, pathIndex);
        for (let index = pathIndex; !result && index < characters.length; index += 1) {
          if (characters[index] === '/') result = matches(patternIndex + 2, index + 1);
        }
      } else {
        result = false;
        for (let index = pathIndex; !result && index <= characters.length; index += 1) {
          result = matches(patternIndex + 1, index);
        }
      }
    } else {
      const character = characters[pathIndex];
      const matched = token.type === 'literal'
        ? character === token.value
        : token.type === 'question'
          ? character != null && character !== '/'
          : character != null && token.ranges.some(([low, high]) => {
            const codePoint = character.codePointAt(0);
            return low <= codePoint && codePoint <= high;
          }) !== token.negative;
      result = matched && matches(patternIndex + 1, pathIndex + 1);
    }

    memo.set(key, result);
    return result;
  }

  return matches(0, 0);
}

function parseRule(raw) {
  if (raw.startsWith('#')) return null;
  let pattern = raw.trim();
  if (!pattern) return null;

  let negative = pattern.startsWith('!');
  if (negative) pattern = pattern.slice(1).trim();
  if (!pattern) throw new SyntaxError('Illegal exclusion pattern: !.');

  pattern = cleanPattern(pattern);
  if (!negative && pattern.startsWith('!')) {
    negative = true;
    pattern = pattern.slice(1);
    if (!pattern) throw new SyntaxError('Illegal exclusion pattern: !.');
  }
  if (pattern === '.') return null;
  validatePattern(pattern);
  return { pattern, negative };
}

function cleanPattern(pattern) {
  let cleaned = path.normalize(pattern);
  if (WINDOWS) cleaned = cleaned.replaceAll('\\', '/');
  if (cleaned.length > 1) cleaned = cleaned.replace(/\/+$/, '');
  if (cleaned.length > 1 && cleaned.startsWith('/')) cleaned = cleaned.slice(1);
  return cleaned;
}

function cleanTarget(pathname) {
  let target = String(pathname);
  if (WINDOWS) target = target.replaceAll('\\', '/');
  target = path.posix.normalize(target || '.');
  if (target.length > 1) target = target.replace(/\/+$/, '');
  return target.startsWith('./') ? target.slice(2) : target;
}

function matchesOrParent(matchesPath, pathname) {
  if (matchesPath(pathname)) return true;
  const segments = pathname.split('/');
  for (let length = 1; length < segments.length; length += 1) {
    if (matchesPath(segments.slice(0, length).join('/'))) return true;
  }
  return false;
}

function compilePattern(pattern) {
  let expression = '^';
  let type = 'exact';
  let inClass = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        const startsPattern = index === 0;
        index += 1;
        if (pattern[index + 1] === '/') index += 1;

        if (index + 1 === pattern.length) {
          if (type === 'exact') type = 'prefix';
          else {
            expression += '[^\\n]*';
            type = 'regexp';
          }
        } else {
          expression += '(?:[^\\n]*/)?';
          type = 'regexp';
        }
        if (startsPattern) type = 'suffix';
      } else {
        expression += '[^/]*';
        type = 'regexp';
      }
    } else if (character === '?') {
      expression += '[^/]';
      type = 'regexp';
    } else if (character === '\\' && !WINDOWS) {
      const next = nextCharacter(pattern, index + 1);
      expression += escapeRegExp(next.value);
      index = next.end - 1;
      type = 'regexp';
    } else if (character === '[' || character === ']') {
      // RE2 accepts a literal closing bracket; JS Unicode regexes require escaping it.
      expression += character === ']' && !inClass ? '\\]' : character;
      inClass = character === '[';
      type = 'regexp';
    } else {
      expression += REGEXP_SPECIAL.test(character) ? `\\${character}` : character;
    }
  }

  if (type === 'exact') return (pathname) => pathname === pattern;
  if (type === 'prefix') {
    const prefix = pattern.slice(0, -2);
    return (pathname) => pathname.startsWith(prefix);
  }
  if (type === 'suffix') {
    const suffix = pattern.slice(2);
    return (pathname) => pathname.endsWith(suffix)
      || (suffix.startsWith('/') && pathname === suffix.slice(1));
  }

  const regexp = new RegExp(`${expression}(?![\\s\\S])`, 'u');
  return (pathname) => regexp.test(pathname);
}

function validatePattern(pattern) {
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\' && !WINDOWS) {
      const next = nextCharacter(pattern, index + 1);
      index = next.end - 1;
    } else if (character === '[') {
      index = validateClass(pattern, index + 1);
    }
  }
}

function tokenizeFilePattern(pattern, globstar) {
  const tokens = [];

  for (let index = 0; index < pattern.length;) {
    const character = pattern[index];
    if (character === '*') {
      let end = index + 1;
      while (pattern[end] === '*') end += 1;
      tokens.push({ type: globstar && end - index >= 2 ? 'globstar' : 'star' });
      index = end;
    } else if (character === '?') {
      tokens.push({ type: 'question' });
      index += 1;
    } else if (character === '\\') {
      const next = nextCharacter(pattern, index + 1);
      tokens.push({ type: 'literal', value: next.value });
      index = next.end;
    } else if (character === '[') {
      const parsed = parseClassToken(pattern, index + 1);
      tokens.push(parsed.token);
      index = parsed.end;
    } else {
      const next = nextCharacter(pattern, index);
      tokens.push({ type: 'literal', value: next.value });
      index = next.end;
    }
  }

  return tokens;
}

function parseClassToken(pattern, start) {
  let index = start;
  const negative = pattern[index] === '^';
  if (negative) index += 1;
  const ranges = [];

  while (index < pattern.length) {
    if (pattern[index] === ']' && ranges.length > 0) {
      return { token: { type: 'class', negative, ranges }, end: index + 1 };
    }
    const low = readClassCharacter(pattern, index);
    index = low.end;
    let high = low;
    if (pattern[index] === '-') {
      high = readClassCharacter(pattern, index + 1);
      index = high.end;
    }
    ranges.push([low.value.codePointAt(0), high.value.codePointAt(0)]);
  }

  throw new SyntaxError('Invalid file pattern.');
}

function readClassCharacter(pattern, index) {
  if (index >= pattern.length || pattern[index] === '-' || pattern[index] === ']') {
    throw new SyntaxError('Invalid file pattern.');
  }
  if (pattern[index] === '\\') index += 1;
  if (index >= pattern.length) throw new SyntaxError('Invalid file pattern.');
  return nextCharacter(pattern, index);
}

function validateClass(pattern, start) {
  let index = pattern[start] === '^' ? start + 1 : start;
  let ranges = 0;

  while (index < pattern.length) {
    if (pattern[index] === ']' && ranges > 0) return index;
    index = consumeClassCharacter(pattern, index);
    if (pattern[index] === '-') index = consumeClassCharacter(pattern, index + 1);
    ranges += 1;
  }

  throw new SyntaxError('Invalid .dockerignore pattern.');
}

function consumeClassCharacter(pattern, index) {
  if (index >= pattern.length || pattern[index] === '-' || pattern[index] === ']') {
    throw new SyntaxError('Invalid .dockerignore pattern.');
  }
  if (pattern[index] === '\\' && !WINDOWS) index += 1;
  if (index >= pattern.length) throw new SyntaxError('Invalid .dockerignore pattern.');
  return nextCharacter(pattern, index).end;
}

function nextCharacter(value, index) {
  if (index >= value.length) throw new SyntaxError('Invalid .dockerignore pattern.');
  const codePoint = value.codePointAt(index);
  const character = String.fromCodePoint(codePoint);
  return { value: character, end: index + character.length };
}

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}
