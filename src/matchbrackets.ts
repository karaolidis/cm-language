import {combineConfig, EditorState, Facet, StateField, Extension} from "@codemirror/state"
import {syntaxTree} from "@codemirror/language"
import {EditorView} from "@codemirror/view"
import {Decoration, DecorationSet} from "@codemirror/view"
import {Range} from "@codemirror/rangeset"
import {Tree, SyntaxNode, NodeType, NodeProp} from "@lezer/common"

export interface Config {
  /// Whether the bracket matching should look at the character after
  /// the cursor when matching (if the one before isn't a bracket).
  /// Defaults to true.
  afterCursor?: boolean
  /// The bracket characters to match, as a string of pairs. Defaults
  /// to `"()[]{}"`. Note that these are only used as fallback when
  /// there is no [matching
  /// information](https://lezer.codemirror.net/docs/ref/#common.NodeProp^closedBy)
  /// in the syntax tree.
  brackets?: string
  /// The maximum distance to scan for matching brackets. This is only
  /// relevant for brackets not encoded in the syntax tree. Defaults
  /// to 10 000.
  maxScanDistance?: number
  /// Can be used to configure the way in which brackets are
  /// decorated. The default behavior is to add the
  /// `cm-matchingBracket` class for matching pairs, and
  /// `cm-nonmatchingBracket` for mismatched pairs or single brackets.
  renderMatch?: (match: MatchResult, state: EditorState) => readonly Range<Decoration>[]
}

const baseTheme = EditorView.baseTheme({
  "&.cm-focused .cm-matchingBracket": {backgroundColor: "#328c8252"},
  "&.cm-focused .cm-nonmatchingBracket": {backgroundColor: "#bb555544"}
})

const DefaultScanDist = 10000, DefaultBrackets = "()[]{}"

const bracketMatchingConfig = Facet.define<Config, Required<Config>>({
  combine(configs) {
    return combineConfig(configs, {
      afterCursor: true,
      brackets: DefaultBrackets,
      maxScanDistance: DefaultScanDist,
      renderMatch: defaultRenderMatch
    })
  }
})

const matchingMark = Decoration.mark({class: "cm-matchingBracket"}),
      nonmatchingMark = Decoration.mark({class: "cm-nonmatchingBracket"})

function defaultRenderMatch(match: MatchResult) {
  let decorations = []
  let mark = match.matched ? matchingMark : nonmatchingMark
  decorations.push(mark.range(match.start.from, match.start.to))
  if (match.end) decorations.push(mark.range(match.end.from, match.end.to))
  return decorations
}

const bracketMatchingState = StateField.define<DecorationSet>({
  create() { return Decoration.none },
  update(deco, tr) {
    if (!tr.docChanged && !tr.selection) return deco
    let decorations: Range<Decoration>[] = []
    let config = tr.state.facet(bracketMatchingConfig)
    for (let range of tr.state.selection.ranges) {
      if (!range.empty) continue
      let match = matchBrackets(tr.state, range.head, -1, config)
        || (range.head > 0 && matchBrackets(tr.state, range.head - 1, 1, config))
        || (config.afterCursor &&
            (matchBrackets(tr.state, range.head, 1, config) ||
             (range.head < tr.state.doc.length && matchBrackets(tr.state, range.head + 1, -1, config))))
      if (match)
        decorations = decorations.concat(config.renderMatch(match, tr.state))
    }
    return Decoration.set(decorations, true)
  },
  provide: f => EditorView.decorations.from(f)
})

const bracketMatchingUnique = [
  bracketMatchingState,
  baseTheme
]

/// Create an extension that enables bracket matching. Whenever the
/// cursor is next to a bracket, that bracket and the one it matches
/// are highlighted. Or, when no matching bracket is found, another
/// highlighting style is used to indicate this.
export function bracketMatching(config: Config = {}): Extension {
  return [bracketMatchingConfig.of(config), bracketMatchingUnique]
}

function matchingNodes(node: NodeType, dir: -1 | 1, brackets: string): null | readonly string[] {
  let byProp = node.prop(dir < 0 ? NodeProp.openedBy : NodeProp.closedBy)
  if (byProp) return byProp
  if (node.name.length == 1) {
    let index = brackets.indexOf(node.name)
    if (index > -1 && index % 2 == (dir < 0 ? 1 : 0))
      return [brackets[index + dir]]
  }
  return null
}


/// The result returned from `matchBrackets`.
export interface MatchResult {
  /// The extent of the bracket token found.
  start: {from: number, to: number},
  /// The extent of the matched token, if any was found.
  end?: {from: number, to: number},
  /// Whether the tokens match. This can be false even when `end` has
  /// a value, if that token doesn't match the opening token.
  matched: boolean
}

/// Find the matching bracket for the token at `pos`, scanning
/// direction `dir`. Only the `brackets` and `maxScanDistance`
/// properties are used from `config`, if given. Returns null if no
/// bracket was found at `pos`, or a match result otherwise.
export function matchBrackets(state: EditorState, pos: number, dir: -1 | 1, config: Config = {}): MatchResult | null {
  let maxScanDistance = config.maxScanDistance || DefaultScanDist, brackets = config.brackets || DefaultBrackets
  let tree = syntaxTree(state), node = tree.resolveInner(pos, dir)
  for (let cur: SyntaxNode | null = node; cur; cur = cur.parent) {
    let matches = matchingNodes(cur.type, dir, brackets)
    if (matches && cur.from < cur.to) return matchMarkedBrackets(state, pos, dir, cur, matches, brackets)
  }
  return matchPlainBrackets(state, pos, dir, tree, node.type, maxScanDistance, brackets)
}

function matchMarkedBrackets(_state: EditorState, _pos: number, dir: -1 | 1, token: SyntaxNode,
                             matching: readonly string[], brackets: string) {
  let parent = token.parent, firstToken = {from: token.from, to: token.to}
  let depth = 0, cursor = parent?.cursor()
  if (cursor && (dir < 0 ? cursor.childBefore(token.from) : cursor.childAfter(token.to))) do {
    if (dir < 0 ? cursor.to <= token.from : cursor.from >= token.to) {
      if (depth == 0 && matching.indexOf(cursor.type.name) > -1 && cursor.from < cursor.to) {
        return {start: firstToken, end: {from: cursor.from, to: cursor.to}, matched: true}
      } else if (matchingNodes(cursor.type, dir, brackets)) {
        depth++
      } else if (matchingNodes(cursor.type, -dir as -1 | 1, brackets)) {
        depth--
        if (depth == 0) return {
          start: firstToken,
          end: cursor.from == cursor.to ? undefined : {from: cursor.from, to: cursor.to},
          matched: false
        }
      }
    }
  } while (dir < 0 ? cursor.prevSibling() : cursor.nextSibling())
  return {start: firstToken, matched: false}
}

function matchPlainBrackets(state: EditorState, pos: number, dir: number, tree: Tree,
                            tokenType: NodeType, maxScanDistance: number, brackets: string) {
  let startCh = dir < 0 ? state.sliceDoc(pos - 1, pos) : state.sliceDoc(pos, pos + 1)
  let bracket = brackets.indexOf(startCh)
  if (bracket < 0 || (bracket % 2 == 0) != (dir > 0)) return null

  let startToken = {from: dir < 0 ? pos - 1 : pos, to: dir > 0 ? pos + 1 : pos}
  let iter = state.doc.iterRange(pos, dir > 0 ? state.doc.length : 0), depth = 0
  for (let distance = 0; !(iter.next()).done && distance <= maxScanDistance;) {
    let text = iter.value
    if (dir < 0) distance += text.length
    let basePos = pos + distance * dir
    for (let pos = dir > 0 ? 0 : text.length - 1, end = dir > 0 ? text.length : -1; pos != end; pos += dir) {
      let found = brackets.indexOf(text[pos])
      if (found < 0 || tree.resolve(basePos + pos, 1).type != tokenType) continue
      if ((found % 2 == 0) == (dir > 0)) {
        depth++
      } else if (depth == 1) { // Closing
        return {start: startToken, end: {from: basePos + pos, to: basePos + pos + 1}, matched: (found >> 1) == (bracket >> 1)}
      } else {
        depth--
      }
    }
    if (dir > 0) distance += text.length
  }
  return iter.done ? {start: startToken, matched: false} : null
}
