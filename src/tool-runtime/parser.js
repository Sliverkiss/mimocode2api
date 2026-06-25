import { findExternalToolByName } from './registry.js';

/**
 * MiMo models output tool calls in THREE different formats.
 * Parser MUST handle all three.
 *
 * Format 1: <function_calls>{JSON}</function_calls>
 * Format 2:  IMD output...
 *            {JSON}
 *             IMD output...
 * Format 3: <function=NAME><parameter=key>val</parameter></function>
 */

const TOOL_TAGS = ['<function_calls>', ' IMM output...'];
const CLOSE_TAGS = ['</function_calls>', ' IMD output...'];
const MAX_BUFFER = 8192;

const FUNC_EQ_REGEX = /<function=(\w+)>([\s\S]*?)<\/function>/g;
const PARAM_REGEX = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/g;

/**
 * Strip ALL tool call markup from text.
 * Handles all 3 MiMo formats.
 */
export function stripFunctionCallMarkup(text, trim = true) {
  if (!text) return text;
  const cleaned = text
    // Format 1: <function_calls>...</function_calls>
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '')
    .replace(/<\/?function_calls>/g, '')
    // Format 2:  IMD output...
    .replace(/ IMD output...[\s\S]*? IMD output.../g, '')
    .replace(/ IMD output.../g, '')
    // Format 3: <function=NAME>...</function>
    .replace(/<function=\w+>[\s\S]*?<\/function>/g, '')
    .replace(/<parameter=\w+>[\s\S]*?<\/parameter>/g, '')
    .replace(/<tool_name>[\s\S]*?<\/tool_name>/g, '')
    .replace(/<parameters>[\s\S]*?<\/parameters>/g, '')
    .replace(/<\/?(tool_name|parameters)>/g, '');
  return trim ? cleaned.trim() : cleaned;
}

/**
 * Strip tool markup from a single delta chunk (for streaming).
 * Same logic as stripFunctionCallMarkup but for per-delta use.
 */
export function stripToolMarkup(text) {
  if (!text) return text;
  return stripFunctionCallMarkup(text, false);
}

/**
 * Strip all formats from final text (for non-streaming).
 */
export function stripToolMarkupText(text) {
  if (!text) return text;
  return stripFunctionCallMarkup(text, true);
}

/**
 * Parse  IMD output... JSON blocks
 */
function parseAntmlBlocks(...chunks) {
  const matches = [];
  chunks.forEach((chunk) => {
    if (!chunk || typeof chunk !== 'string') return;
    // Match  IMD output...\n{JSON}\n IMD output...
    const blocks = chunk.matchAll(/ IMD output...[\s\S]*? IMD output.../g);
    for (const block of blocks) {
      const raw = block[0];
      // Extract JSON between the tags
      const jsonStr = raw.replace(/^ IMD output.../, '').replace(/ IMD output...$/, '').trim();
      if (!jsonStr) continue;
      try {
        const parsed = JSON.parse(jsonStr);
        const rawCalls = Array.isArray(parsed) ? parsed : [parsed];
        rawCalls.forEach((rawCall, index) => {
          const name = rawCall?.function?.name || rawCall?.name;
          const rawArgs = rawCall?.function?.arguments ?? rawCall?.arguments ?? {};
          if (!name) return;
          matches.push({
            id: rawCall?.id || `call_${Date.now()}_${matches.length + index + 1}`,
            type: 'function',
            function: {
              name,
              arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs)
            }
          });
        });
      } catch {
        // JSON parse failed, skip
      }
    }
  });
  return matches;
}

/**
 * Parse MiMo-style XML function calls:
 *   <function=bash>
 *   <parameter=command>date</parameter>
 *   </function>
 */
function parseFuncEqBlocks(...chunks) {
  const matches = [];
  chunks.forEach((chunk) => {
    if (!chunk || typeof chunk !== 'string') return;
    FUNC_EQ_REGEX.lastIndex = 0;
    const funcBlocks = [...chunk.matchAll(FUNC_EQ_REGEX)];
    for (const block of funcBlocks) {
      const funcName = block[1];
      const funcBody = block[2];
      if (!funcName) continue;
      const args = {};
      PARAM_REGEX.lastIndex = 0;
      const paramBlocks = [...funcBody.matchAll(PARAM_REGEX)];
      for (const param of paramBlocks) {
        const key = param[1];
        const value = param[2]?.trim() || '';
        args[key] = value;
      }
      matches.push({
        id: `call_${funcName}_${Date.now()}_${matches.length + 1}`,
        type: 'function',
        function: { name: funcName, arguments: JSON.stringify(args) }
      });
    }

    // Also handle <tool_name>NAME</tool_name><parameters>...</parameters>
    const funcBlocks2 = [...chunk.matchAll(/<tool_name>(\w+)<\/tool_name>([\s\S]*?)<\/parameters>/g)];
    for (const block of funcBlocks2) {
      const funcName = block[1];
      const funcBody = block[2];
      if (!funcName) continue;
      const cleanBody = funcBody.replace(/^<parameters>/, '');
      const args = {};
      const paramBlocks = [...cleanBody.matchAll(/<(\w+)>([\s\S]*?)<\/\w+>/g)];
      for (const param of paramBlocks) {
        const key = param[1];
        const value = param[2]?.trim() || '';
        if (key === 'tool_name' || key === 'parameters') continue;
        args[key] = value;
      }
      matches.push({
        id: `call_${funcName}_${Date.now()}_${matches.length + 1}`,
        type: 'function',
        function: { name: funcName, arguments: JSON.stringify(args) }
      });
    }
  });
  return matches;
}

/**
 * Parse OpenAI-style <function_calls>JSON</function_calls> blocks
 */
function parseStandardFunctionCalls(...chunks) {
  const matches = [];
  chunks.forEach((chunk) => {
    if (!chunk || typeof chunk !== 'string') return;
    const blocks = chunk.matchAll(/<function_calls>([\s\S]*?)<\/function_calls>/g);
    for (const block of blocks) {
      const payload = block?.[1]?.trim();
      if (!payload) continue;
      try {
        const parsed = JSON.parse(payload);
        const rawCalls = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.tool_calls)
            ? parsed.tool_calls
            : [parsed];
        rawCalls.forEach((rawCall, index) => {
          const name = rawCall?.function?.name || rawCall?.name;
          const rawArgs = rawCall?.function?.arguments ?? rawCall?.arguments ?? {};
          if (!name) return;
          matches.push({
            id: rawCall?.id || `call_${Date.now()}_${matches.length + index + 1}`,
            type: 'function',
            function: {
              name,
              arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs)
            }
          });
        });
      } catch {
        // JSON parse failed, skip
      }
    }
  });
  return matches;
}

/**
 * Parse tool calls from text. Tries all 3 formats.
 */
export function parseToolCallsFromText(...chunks) {
  const standardCalls = parseStandardFunctionCalls(...chunks);
  const antmlCalls = parseAntmlBlocks(...chunks);
  const mimoCalls = parseFuncEqBlocks(...chunks);
  return [...standardCalls, ...antmlCalls, ...mimoCalls];
}

/**
 * Parse external tool calls, filtering by registry.
 */
export function parseExternalToolCallsFromText(registry, ...chunks) {
  if (!Array.isArray(registry) || registry.length === 0) return [];
  const rawCalls = parseToolCallsFromText(...chunks);
  const counts = new Map();
  return rawCalls.flatMap((rawCall) => {
    const tool = findExternalToolByName(registry, rawCall?.function?.name);
    if (!tool) return [];
    const nextCount = (counts.get(tool.namespacedName) || 0) + 1;
    counts.set(tool.namespacedName, nextCount);
    return [{
      id: rawCall.id || `call_${tool.namespacedName.replace(/[^a-zA-Z0-9_]/g, '_')}_${nextCount}`,
      type: 'function',
      function: {
        name: tool.originalName,
        arguments: rawCall.function.arguments
      }
    }];
  });
}

/**
 * Create a streaming filter that strips all tool call markup.
 * State machine handles blocks that span multiple deltas.
 */
export function createToolCallFilter({ disableTools, forceStrip = false }) {
  if (!disableTools && !forceStrip) return (chunk) => chunk;
  let inBlock = false;
  let inMimoBlock = false;
  let inAntmlBlock = false;
  return (chunk) => {
    if (!chunk) return chunk;
    let output = '';
    let remaining = chunk;
    while (remaining.length) {
      if (inBlock) {
        const endIdx = remaining.indexOf('</function_calls>');
        if (endIdx === -1) return output;
        remaining = remaining.slice(endIdx + '</function_calls>'.length);
        inBlock = false;
        continue;
      }
      if (inMimoBlock) {
        const endIdx = remaining.indexOf('</function>');
        if (endIdx === -1) return output;
        remaining = remaining.slice(endIdx + '</function>'.length);
        inMimoBlock = false;
        continue;
      }
      if (inAntmlBlock) {
        const endIdx = remaining.indexOf(' IMD output...');
        if (endIdx === -1) return output;
        remaining = remaining.slice(endIdx + ' IMD output...'.length);
        inAntmlBlock = false;
        continue;
      }
      const startIdxStd = remaining.indexOf('<function_calls>');
      const startIdxMimo = remaining.indexOf('<function=');
      const startIdxAntml = remaining.indexOf(' IMD output...');
      const indices = [
        { idx: startIdxStd, tag: 'std' },
        { idx: startIdxMimo, tag: 'mimo' },
        { idx: startIdxAntml, tag: 'antml' }
      ].filter((e) => e.idx !== -1);
      if (indices.length === 0) {
        output += remaining;
        return output;
      }
      const first = indices.sort((a, b) => a.idx - b.idx)[0];
      output += remaining.slice(0, first.idx);
      if (first.tag === 'std') {
        remaining = remaining.slice(first.idx + '<function_calls>'.length);
        inBlock = true;
      } else if (first.tag === 'mimo') {
        remaining = remaining.slice(first.idx);
        inMimoBlock = true;
      } else {
        remaining = remaining.slice(first.idx + ' IMD output...'.length);
        inAntmlBlock = true;
      }
    }
    return output;
  };
}

/**
 * Create a streaming parser for external tool calls.
 * Handles all 3 MiMo formats with tag-aware buffer truncation.
 * Buffer is 8192 chars — never truncate past an unclosed opening tag.
 */
export function createExternalToolCallStreamParser(registry) {
  if (!Array.isArray(registry) || registry.length === 0) {
    return () => [];
  }
  let buffer = '';
  return (chunk) => {
    if (!chunk) return [];
    buffer += chunk;
    const parsedCalls = [];

    while (buffer.length) {
      // Find the earliest opening tag
      const startIdxStd = buffer.indexOf('<function_calls>');
      const startIdxMimo = buffer.indexOf('<function=');
      const startIdxAntml = buffer.indexOf(' IMD output...');

      const indices = [
        { idx: startIdxStd, tag: 'std', openTag: '<function_calls>', closeTag: '</function_calls>' },
        { idx: startIdxMimo, tag: 'mimo', openTag: '<function=', closeTag: '</function>' },
        { idx: startIdxAntml, tag: 'antml', openTag: ' IMD output...', closeTag: ' IMD output...' }
      ].filter((e) => e.idx !== -1);

      if (indices.length === 0) {
        // No opening tag found — keep tail that could be start of a tag
        const maxTagLen = Math.max(
          '<function_calls>'.length,
          '<function='.length,
          ' IMD output...'.length
        ) - 1;
        if (buffer.length > maxTagLen) {
          buffer = buffer.slice(-maxTagLen);
        }
        break;
      }

      const first = indices.sort((a, b) => a.idx - b.idx)[0];

      if (first.tag === 'std') {
        // Standard format: <function_calls>...</function_calls>
        const endIdx = buffer.indexOf(first.closeTag, first.idx + first.openTag.length);
        if (endIdx === -1) {
          // Block not complete yet — keep from opening tag, but check buffer size
          if (buffer.length - first.idx > MAX_BUFFER) {
            // Buffer overflow — discard this incomplete block
            buffer = buffer.slice(first.idx + first.openTag.length);
          } else {
            buffer = buffer.slice(first.idx);
          }
          break;
        }
        const block = buffer.slice(first.idx, endIdx + first.closeTag.length);
        parsedCalls.push(...parseExternalToolCallsFromText(registry, block));
        buffer = buffer.slice(endIdx + first.closeTag.length);
      } else if (first.tag === 'mimo') {
        // MiMo XML format: <function=NAME>...</function>
        const endIdx = buffer.indexOf(first.closeTag, first.idx + first.openTag.length);
        if (endIdx === -1) {
          if (buffer.length - first.idx > MAX_BUFFER) {
            buffer = buffer.slice(first.idx + first.openTag.length);
          } else {
            buffer = buffer.slice(first.idx);
          }
          break;
        }
        const block = buffer.slice(first.idx, endIdx + first.closeTag.length);
        parsedCalls.push(...parseExternalToolCallsFromText(registry, block));
        buffer = buffer.slice(endIdx + first.closeTag.length);
      } else {
        //  IMD output... JSON  IMD output...
        const endIdx = buffer.indexOf(first.closeTag, first.idx + first.openTag.length);
        if (endIdx === -1) {
          if (buffer.length - first.idx > MAX_BUFFER) {
            buffer = buffer.slice(first.idx + first.openTag.length);
          } else {
            buffer = buffer.slice(first.idx);
          }
          break;
        }
        const block = buffer.slice(first.idx, endIdx + first.closeTag.length);
        parsedCalls.push(...parseExternalToolCallsFromText(registry, block));
        buffer = buffer.slice(endIdx + first.closeTag.length);
      }
    }
    return parsedCalls;
  };
}
