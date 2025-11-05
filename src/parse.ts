/*
 * parse.ts - Convert a build.gradle file to a js representation
 *
 * Copyright © 2017, HealthTap, Inc., © 2025, Box, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import deepAssign from 'deep-assign';

// Character code constants
const CHAR_TAB = 9;
const CHAR_NEWLINE = 10;
const CHAR_SPACE = 32;
const CHAR_LEFT_PARENTHESIS = 40;
const CHAR_RIGHT_PARENTHESIS = 41;
const CHAR_SLASH = 47;
const CHAR_EQUALS = 61;
const CHAR_ARRAY_START = 91;
const CHAR_ARRAY_END = 93;
const CHAR_BLOCK_START = 123;
const CHAR_BLOCK_END = 125;

// Keyword constants
const KEYWORD_DEF = 'def';
const KEYWORD_IF = 'if';

// Whitespace character lookup
const WHITESPACE_CHARACTERS: { [key: number]: boolean } = {};
WHITESPACE_CHARACTERS[CHAR_TAB] = true;
WHITESPACE_CHARACTERS[CHAR_NEWLINE] = true;
WHITESPACE_CHARACTERS[CHAR_SPACE] = true;

// Comment markers
const SINGLE_LINE_COMMENT_START = '//';
const BLOCK_COMMENT_START = '/*';
const BLOCK_COMMENT_END = '*/';

// Type definitions
export interface ParseState {
    index: number;
    comment: CommentState;
}

interface CommentState {
    parsing: boolean;
    singleLine: boolean;
    multiLine: boolean;
    setSingleLine(): void;
    setMultiLine(): void;
    reset(): void;
    _setCommentState(singleLine: boolean, multiLine: boolean): void;
}

export interface Dependency {
    type: string;
    group: string;
    name: string;
    version: string;
    excludes: Array<Record<string, string>>;
}

export interface Repository {
    type: string;
    data: Record<string, any>;
}

export type ParsedValue = string | boolean | ParsedObject | string[] | Dependency[] | Repository[];
export type ParsedObject = { [key: string]: ParsedValue };

interface DependencyItemBlockInfo {
    gav?: string;
    type?: string;
    excludes?: Array<Record<string, string>>;
}

interface GavObject {
    group: string;
    name: string;
    version: string;
}

// Regex patterns for dependency parsing
const DEPS_KEYWORD_STRING_PATTERN = '[ \\t]*([A-Za-z0-9_-]+)[ \\t]*';
const DEPS_KEYWORD_STRING_REGEX = RegExp(DEPS_KEYWORD_STRING_PATTERN);
const DEPS_EASY_GAV_STRING_REGEX = RegExp('(["\']?)([\\w.-]+):([\\w.-]+):([\\w.-]+)\\1');
const DEPS_HARD_GAV_STRING_REGEX = RegExp(DEPS_KEYWORD_STRING_PATTERN + '(?:\\((.*)\\)|(.*))');
const DEPS_ITEM_BLOCK_REGEX = RegExp(DEPS_KEYWORD_STRING_PATTERN + '\\(((["\']?)(.*)\\3)\\)[ \\t]*\\{');
const DEPS_EXCLUDE_LINE_REGEX = RegExp('exclude[ \\t]+([^\\n]+)', 'g');

// Special key parsers
const SPECIAL_KEYS: { [key: string]: (chunk: number[], state: ParseState) => Dependency[] | Repository[] } = {
    repositories: parseRepositoryClosure,
    dependencies: parseDependencyClosure
};

function deepParse(chunk: number[], state: ParseState, keepFunctionCalls: boolean, skipEmptyValues?: boolean): ParsedObject {
    const out: ParsedObject = {};

    const chunkLength = chunk.length;
    let character = 0;
    let tempString = '';
    let commentText = '';

    let currentKey = '';
    let parsingKey = true;
    let isBeginningOfLine = true;

    if (typeof skipEmptyValues === 'undefined') {
        skipEmptyValues = true;
    }

    for (; state.index < chunkLength; state.index++) {
        character = chunk[state.index];

        if (isBeginningOfLine && isWhitespace(character)) {
            continue;
        }

        if (!state.comment.parsing && isBeginningOfLine && isStartOfComment(tempString)) {
            isBeginningOfLine = false;
            if (isSingleLineComment(tempString)) {
                state.comment.setSingleLine();
            } else {
                state.comment.setMultiLine();
            }
            continue;
        }

        if (state.comment.multiLine && isEndOfMultiLineComment(commentText)) {
            state.comment.reset();

            isBeginningOfLine = true;
            tempString = '';
            commentText = '';
            continue;
        }

        if (state.comment.parsing && character !== CHAR_NEWLINE) {
            commentText += String.fromCharCode(character);
            continue;
        }

        if (state.comment.parsing && character === CHAR_NEWLINE) {
            if (state.comment.singleLine) {
                state.comment.reset();
                isBeginningOfLine = true;

                currentKey = '';
                tempString = '';
                commentText = '';
                continue;
            } else {
                // NO-OP
                continue;
            }
        }

        if (parsingKey && !keepFunctionCalls && character === CHAR_LEFT_PARENTHESIS) {
            skipFunctionCall(chunk, state);
            currentKey = '';
            tempString = '';
            continue;
        }

        if (character === CHAR_NEWLINE) {
            if (!currentKey && tempString) {
                currentKey = tempString;
                tempString = '';
            }

            if (tempString || (currentKey && !skipEmptyValues)) {
                addValueToStructure(out, currentKey, trimWrappingQuotes(tempString));

                currentKey = '';
                tempString = '';
            }

            parsingKey = true;
            isBeginningOfLine = true;

            state.comment.reset();
            continue;
        }

        // Only parse as an array if the first *real* char is a [
        if (!parsingKey && !tempString && character === CHAR_ARRAY_START) {
            out[currentKey] = parseArray(chunk, state);
            currentKey = '';
            tempString = '';
            continue;
        }

        if (character === CHAR_BLOCK_START && !parsingKey) {
            state.index++; // We need to skip the start character

            if (SPECIAL_KEYS.hasOwnProperty(currentKey)) {
                out[currentKey] = SPECIAL_KEYS[currentKey](chunk, state);
            } else if (out[currentKey]) {
                out[currentKey] = deepAssign({}, out[currentKey], deepParse(chunk, state, keepFunctionCalls, skipEmptyValues));
            } else {
                out[currentKey] = deepParse(chunk, state, keepFunctionCalls, skipEmptyValues);
            }
            currentKey = '';
        } else if (character === CHAR_BLOCK_END && !parsingKey) {
            currentKey = '';
            tempString = '';
            break;
        } else if ((isDelimiter(character) || character === CHAR_BLOCK_START || character === CHAR_BLOCK_END) && parsingKey) {
            if (isKeyword(tempString)) {
                if (tempString === KEYWORD_DEF) {
                    tempString = fetchDefinedNameOrSkipFunctionDefinition(chunk, state);
                } else if (tempString === KEYWORD_IF) {
                    skipIfBlock(chunk, state);
                    currentKey = '';
                    tempString = '';
                    continue;
                }
            }

            currentKey = tempString;
            tempString = '';
            parsingKey = false;
            if (character === CHAR_BLOCK_START || character === CHAR_BLOCK_END) {
                state.index--;
            }
            if (!currentKey) {
                continue;
            }
        } else {
            if (!tempString && isDelimiter(character)) {
                continue;
            }
            tempString += String.fromCharCode(character);
            isBeginningOfLine = isBeginningOfLine && (character === CHAR_SLASH || isStartOfComment(tempString));
        }
    }

    // Add the last value to the structure
    addValueToStructure(out, currentKey, trimWrappingQuotes(tempString));
    return out;
}

function skipIfBlock(chunk: number[], state: ParseState): boolean {
    skipFunctionCall(chunk, state);

    let character = 0;
    let hasFoundTheCurlyBraces = false;
    let curlyBraceCount = 0;
    for (let max = chunk.length; state.index < max; state.index++) {
        character = chunk[state.index];
        if (character === CHAR_BLOCK_START) {
            hasFoundTheCurlyBraces = true;
            curlyBraceCount++;
        } else if (character === CHAR_BLOCK_END) {
            curlyBraceCount--;
        }

        if (hasFoundTheCurlyBraces && curlyBraceCount === 0) {
            break;
        }
    }
    return curlyBraceCount === 0;
}

function skipFunctionDefinition(chunk: number[], state: ParseState): void {
    const start = state.index;
    let parenthesisNest = 1;
    let character = chunk[++state.index];
    while (character !== undefined && parenthesisNest) {
        if (character === CHAR_LEFT_PARENTHESIS) {
            parenthesisNest++;
        } else if (character === CHAR_RIGHT_PARENTHESIS) {
            parenthesisNest--;
        }

        character = chunk[++state.index];
    }

    while (character && character !== CHAR_BLOCK_START) {
        character = chunk[++state.index];
    }

    character = chunk[++state.index];
    let blockNest = 1;
    while (character !== undefined && blockNest) {
        if (character === CHAR_BLOCK_START) {
            blockNest++;
        } else if (character === CHAR_BLOCK_END) {
            blockNest--;
        }

        character = chunk[++state.index];
    }

    state.index--;
}

function parseDependencyClosure(chunk: number[], state: ParseState): Dependency[] {
    const out: Dependency[] = [];

    // openBlockCount starts at 1 due to us entering after "dependencies {"
    let openBlockCount = 1;
    let currentKey = '';
    let currentValue = '';

    let isInItemBlock = false;
    for (; state.index < chunk.length; state.index++) {
        if (chunk[state.index] === CHAR_BLOCK_START) {
            openBlockCount++;
        } else if (chunk[state.index] === CHAR_BLOCK_END) {
            openBlockCount--;
        } else {
            currentKey += String.fromCharCode(chunk[state.index]);
        }

        // Keys shouldn't have any leading nor trailing whitespace
        currentKey = currentKey.trim();

        if (isStartOfComment(currentKey)) {
            let commentText = currentKey;
            for (state.index = state.index + 1; state.index < chunk.length; state.index++) {
                if (isCommentComplete(commentText, chunk[state.index])) {
                    currentKey = '';
                    break;
                }
                commentText += String.fromCharCode(chunk[state.index]);
            }
        }

        if (currentKey && isWhitespace(chunk[state.index])) {
            let character = 0;
            for (state.index = state.index + 1; state.index < chunk.length; state.index++) {
                character = chunk[state.index];
                currentValue += String.fromCharCode(character);

                if (character === CHAR_BLOCK_START) {
                    isInItemBlock = true;
                } else if (isInItemBlock && character === CHAR_BLOCK_END) {
                    isInItemBlock = false;
                } else if (!isInItemBlock) {
                    if (character === CHAR_NEWLINE && currentValue) {
                        break;
                    }
                }
            }

            out.push(createStructureForDependencyItem(currentKey + ' ' + currentValue));
            currentKey = '';
            currentValue = '';
        }

        if (openBlockCount === 0) {
            break;
        }
    }
    return out;
}

function createStructureForDependencyItem(data: string): Dependency {
    let out: Dependency = { group: '', name: '', version: '', type: '', excludes: [] };
    const compileBlockInfo = findDependencyItemBlock(data);
    if (compileBlockInfo['gav']) {
        out = { ...parseGavString(compileBlockInfo['gav']!), type: compileBlockInfo['type'] || '', excludes: compileBlockInfo['excludes'] || [] };
    } else {
        const match = DEPS_KEYWORD_STRING_REGEX.exec(data);
        out = { ...parseGavString(data), type: match ? match[1] : '', excludes: [] };
    }
    return out;
}

function findFirstSpaceOrTabPosition(input: string): number {
    let position = input.indexOf(' ');
    if (position === -1) {
        position = input.indexOf('\t');
    }
    return position;
}

function findDependencyItemBlock(data: string): DependencyItemBlockInfo {
    const matches = DEPS_ITEM_BLOCK_REGEX.exec(data);
    if (matches && matches[2]) {
        const excludes: Array<Record<string, string>> = [];

        let match: RegExpExecArray | null;
        while ((match = DEPS_EXCLUDE_LINE_REGEX.exec(data))) {
            excludes.push(parseMapNotation(match[0].substring(findFirstSpaceOrTabPosition(match[0]))));
        }

        return { gav: matches[2], type: matches[1], excludes: excludes };
    }
    return {};
}

function parseGavString(gavString: string): GavObject {
    let out: GavObject = { group: '', name: '', version: '' };
    const easyGavStringMatches = DEPS_EASY_GAV_STRING_REGEX.exec(gavString);
    if (easyGavStringMatches) {
        out['group'] = easyGavStringMatches[2];
        out['name'] = easyGavStringMatches[3];
        out['version'] = easyGavStringMatches[4];
    } else if (gavString.indexOf('project(') !== -1) {
        const projectMatch = gavString.match(/(project\([^\)]+\))/g);
        out['name'] = projectMatch ? projectMatch[0] : '';
    } else {
        const hardGavMatches = DEPS_HARD_GAV_STRING_REGEX.exec(gavString);
        if (hardGavMatches && (hardGavMatches[3] || hardGavMatches[2])) {
            out = parseMapNotationWithFallback(out, hardGavMatches[3] || hardGavMatches[2]);
        } else {
            out = parseMapNotationWithFallback(out, gavString, gavString.slice(findFirstSpaceOrTabPosition(gavString)));
        }
    }
    return out;
}

function parseMapNotationWithFallback(out: GavObject, string: string, name?: string): GavObject {
    const outFromMapNotation = parseMapNotation(string);
    if (outFromMapNotation['name']) {
        return {
            group: outFromMapNotation['group'] || '',
            name: outFromMapNotation['name'] || '',
            version: outFromMapNotation['version'] || ''
        };
    } else {
        out['name'] = name ? name : string;
        return out;
    }
}

function parseMapNotation(input: string): Record<string, string> {
    const out: Record<string, string> = {};
    let currentKey = '';
    let quotation = '';

    for (let i = 0, max = input.length; i < max; i++) {
        if (input[i] === ':') {
            currentKey = currentKey.trim();
            out[currentKey] = '';

            // Skip the colon and start processing the value
            let innerLoop = 0;
            for (i = i + 1; i < max; i++) {
                if (innerLoop === 0) {
                    // Skip any leading spaces before the actual value
                    if (isWhitespaceLiteral(input[i])) {
                        continue;
                    }
                }

                // We just take note of what the "latest" quote was so that we can
                if (input[i] === '"' || input[i] === "'") {
                    quotation = input[i];
                    continue;
                }

                // Moving on to the next value if we find a comma
                if (input[i] === ',') {
                    out[currentKey] = out[currentKey].trim();
                    currentKey = '';
                    break;
                }

                out[currentKey] += input[i];
                innerLoop++;
            }
        } else {
            currentKey += input[i];
        }
    }

    // If the last character contains a quotation mark, we remove it
    if (out[currentKey]) {
        out[currentKey] = out[currentKey].trim();
        if (out[currentKey].slice(-1) === quotation) {
            out[currentKey] = out[currentKey].slice(0, -1);
        }
    }
    return out;
}

function parseRepositoryClosure(chunk: number[], state: ParseState): Repository[] {
    const out: Repository[] = [];
    const repository = deepParse(chunk, state, true, false);
    Object.keys(repository).forEach(function(item) {
        if (repository[item]) {
            out.push({ type: item, data: repository[item] as Record<string, any> });
        } else {
            out.push({ type: 'unknown', data: { name: item } });
        }
    });
    return out;
}

function fetchDefinedNameOrSkipFunctionDefinition(chunk: number[], state: ParseState): string {
    let character = 0;
    let temp = '';
    let isVariableDefinition = true;
    for (let max = chunk.length; state.index < max; state.index++) {
        character = chunk[state.index];

        if (character === CHAR_EQUALS) {
            // Variable definition, break and return name
            break;
        } else if (character === CHAR_LEFT_PARENTHESIS) {
            // Function definition, skip parsing
            isVariableDefinition = false;
            skipFunctionDefinition(chunk, state);
            break;
        }

        temp += String.fromCharCode(character);
    }

    if (isVariableDefinition) {
        const values = temp.trim().split(' ');
        return values[values.length - 1];
    } else {
        return '';
    }
}

function parseArray(chunk: number[], state: ParseState): string[] {
    let character = 0;
    let temp = '';
    for (let max = chunk.length; state.index < max; state.index++) {
        character = chunk[state.index];
        if (character === CHAR_ARRAY_START) {
            continue;
        } else if (character === CHAR_ARRAY_END) {
            break;
        }
        temp += String.fromCharCode(character);
    }

    return temp.split(',').map(function(item) {
        return trimWrappingQuotes(item.trim());
    });
}

function skipFunctionCall(chunk: number[], state: ParseState): boolean {
    let openParenthesisCount = 0;
    let character = 0;
    for (let max = chunk.length; state.index < max; state.index++) {
        character = chunk[state.index];
        if (character === CHAR_LEFT_PARENTHESIS) {
            openParenthesisCount++;
        } else if (character === CHAR_RIGHT_PARENTHESIS) {
            openParenthesisCount--;
        }

        if (openParenthesisCount === 0) {
            break;
        }
    }
    return openParenthesisCount === 0;
}

function addValueToStructure(structure: ParsedObject, currentKey: string, value: string): void {
    if (currentKey) {
        if (structure.hasOwnProperty(currentKey)) {
            const currentValue = structure[currentKey];
            if (Array.isArray(currentValue)) {
                (currentValue as any[]).push(getRealValue(value));
            } else {
                structure[currentKey] = [currentValue, getRealValue(value)] as ParsedValue;
            }
        } else {
            structure[currentKey] = getRealValue(value);
        }
    }
}

function getRealValue(value: string): string | boolean {
    if (value === 'true' || value === 'false') {
        // booleans
        return value === 'true';
    }

    return value;
}

function trimWrappingQuotes(string: string): string {
    const firstCharacter = string.slice(0, 1);
    if (firstCharacter === '"') {
        return string.replace(/^"([^"]+)"$/g, '$1');
    } else if (firstCharacter === "'") {
        return string.replace(/^'([^']+)'$/g, '$1');
    }
    return string;
}

function isDelimiter(character: number): boolean {
    return character === CHAR_SPACE || character === CHAR_EQUALS;
}

function isWhitespace(character: number): boolean {
    return WHITESPACE_CHARACTERS.hasOwnProperty(character);
}

function isWhitespaceLiteral(character: string): boolean {
    return isWhitespace(character.charCodeAt(0));
}

function isKeyword(string: string): boolean {
    return string === KEYWORD_DEF || string === KEYWORD_IF;
}

function isSingleLineComment(comment: string): boolean {
    return comment.slice(0, 2) === SINGLE_LINE_COMMENT_START;
}

function isStartOfComment(snippet: string): boolean {
    return snippet === BLOCK_COMMENT_START || snippet === SINGLE_LINE_COMMENT_START;
}

function isCommentComplete(text: string, next: number): boolean {
    return (next === CHAR_NEWLINE && isSingleLineComment(text)) || (isWhitespace(next) && isEndOfMultiLineComment(text));
}

function isEndOfMultiLineComment(comment: string): boolean {
    return comment.slice(-2) === BLOCK_COMMENT_END;
}

function createCommentState(): CommentState {
    return {
        parsing: false,
        singleLine: false,
        multiLine: false,
        setSingleLine: function() {
            this._setCommentState(true, false);
        },
        setMultiLine: function() {
            this._setCommentState(false, true);
        },
        reset: function() {
            this._setCommentState(false, false);
        },
        _setCommentState: function(singleLine: boolean, multiLine: boolean) {
            this.singleLine = singleLine;
            this.multiLine = multiLine;
            this.parsing = singleLine || multiLine;
        }
    };
}

export function parse(str: string): ParsedObject {
    const state: ParseState = {
        index: 0,
        comment: createCommentState()
    };
    const chunk: number[] = [];
    for (let i = 0; i < str.length; i++) {
        chunk.push(str.charCodeAt(i));
    }
    return deepParse(chunk, state, false, undefined);
}

export default parse;

