/**
 * MarkdownText — the transcript's formatted prose renderer (R109: "the
 * responses are not formatted, some responses are not made bold" — the
 * prose half of the fix). Renders the pure parser's Block tree in the clay
 * language: bold is bold, code blocks are mono tiles, quotes carry the
 * accent2 edge, tables are hairline rows, links open in the browser.
 *
 * Inline rendering rides NESTED <Text> (React Native's native inline-flow:
 * a child Text inherits the parent's font and applies its own style), which
 * is why bold/italic/code/link mix correctly inside one paragraph.
 * Streaming-safe: the parent memoizes on the content string; a delta
 * re-parse is O(n) and cheap.
 *
 * R115-J — the transcript polish pass (spacing/typography only, the parser
 * untouched): headings breathe one step more above them (sm), list rows
 * gain 2px of rhythm, and the code tile's radius now reads the token
 * contract (RADIUS_INPUT) instead of a bare 14.
 *
 * ROUND-120 (R120-CM, §1 item 41 — "the AI responses are badly
 * formatted"): the AUDIT's verdict + fixes. What was flat: (1) headings
 * carried inline sizes (21/18/16/15) outside the type ladder — donts #12
 * — and level 4 rendered at plain-body weight; the ladder mapping now
 * lives in the PURE `headingTier` (features/markdown.ts: H1 Title 20/700,
 * H2 Heading 16/700, H3 16/600, H4 BodyStrong 15/600) and the heading
 * Text carries accessibilityRole="header". (2) code blocks dropped the
 * parser's `lang` on the floor — the tile now leads with the mono micro
 * language label (the wire's own spelling, never transformed) and the
 * block's a11y label names it. (3) inline code / lists / bold / italic /
 * links audited GREEN (mono+bg tiles, markers, nested weights, the
 * accent underline) — untouched. Dense + textScale keep the R114-d law:
 * the heading ladder and the mono/code tokens are the calibration marks.
 */

import { useMemo } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTheme } from "@/design/theme";
import { Hairline } from "@/design/primitives";
import { fontFamily, RADIUS_INPUT, spacing, TYPE_MICRO } from "@/design/tokens";
import { headingTier, parseMarkdown, type Block, type HeadingTier, type Inline, type ListItem } from "@/features/markdown";
import { mobWarn } from "@/lib/log";

export interface MarkdownTextProps {
  content: string;
  /** Base text color override (defaults to the theme ink). */
  color?: string;
  /** Dense mode (tool output tails etc.) — smaller body. */
  dense?: boolean;
  /** R114-d — the chatTextSize pref's body-text scale (0.92/1.0/1.08). Scales
   * the PARAGRAPH body + line height only; code blocks/mono stay unscaled
   * (the calibration marks — features/chat-prefs.ts). */
  textScale?: number;
  testID?: string;
}

export function MarkdownText({ content, color, dense = false, textScale = 1, testID }: MarkdownTextProps) {
  const { tokens } = useTheme();
  const blocks = useMemo(() => parseMarkdown(content), [content]);
  const ink = color ?? tokens.text;

  return (
    <View testID={testID} style={styles.root} pointerEvents="box-none">
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} ink={ink} dense={dense} textScale={textScale} />
      ))}
    </View>
  );
}

// ── the block renderer ──────────────────────────────────────────────────────

function BlockView({
  block,
  ink,
  dense,
  textScale,
}: {
  block: Block;
  ink: string;
  dense: boolean;
  textScale: number;
}) {
  const { tokens } = useTheme();
  switch (block.t) {
    case "paragraph":
      return <InlineText inlines={block.inlines} ink={ink} dense={dense} textScale={textScale} />;
    case "heading": {
      // R120-CM — the house Type ladder (the pure headingTier table): H1
      // Title 20/700, H2 Heading 16/700, H3 16/600, H4 BodyStrong 15/600.
      // dense/textScale never demote it (the R114-d calibration-mark law).
      return (
        <View style={styles.heading}>
          <InlineText inlines={block.inlines} ink={ink} headingTier={headingTier(block.level)} />
        </View>
      );
    }
    case "code":
      return (
        <View
          accessibilityLabel={block.lang !== null ? `code block, ${block.lang}` : "code block"}
          style={[styles.codeBlock, { backgroundColor: tokens.monoBg, borderColor: tokens.monoBorder }]}
        >
          {block.lang !== null && block.lang !== "" && (
            // R120-CM — the parser's carried language, finally rendered: the
            // wire's own spelling (never uppercased, never guessed), mono
            // micro tertiary — the tile's quiet header line.
            <Text style={[styles.codeLang, { color: tokens.textTertiary }]} numberOfLines={1}>
              {block.lang}
            </Text>
          )}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View>
              {block.lines.map((line, i) => (
                <Text key={i} style={[styles.codeLine, { color: tokens.monoText }]}>
                  {line === "" ? " " : line}
                </Text>
              ))}
            </View>
          </ScrollView>
        </View>
      );
    case "quote":
      return (
        <View style={[styles.quote, { borderLeftColor: tokens.accent2 }]}>
          <InlineText inlines={block.inlines} ink={tokens.textSecondary} dense={dense} textScale={textScale} />
        </View>
      );
    case "hr":
      return <Hairline style={{ marginVertical: spacing.xs }} />;
    case "list":
      return (
        <View style={styles.list}>
          {block.items.map((item, i) => (
            <ListRow key={i} item={item} ordered={block.ordered} index={i + 1} ink={ink} dense={dense} textScale={textScale} />
          ))}
        </View>
      );
    case "table":
      return (
        <View style={[styles.table, { borderColor: tokens.borderSubtle }]}>
          <View style={[styles.tableRow, styles.tableHead, { borderBottomColor: tokens.border }]}>
            {block.header.map((cell, i) => (
              <View key={i} style={styles.tableCell}>
                <InlineText inlines={cell} ink={ink} dense />
              </View>
            ))}
          </View>
          {block.rows.map((row, r) => (
            <View key={r} style={[styles.tableRow, r > 0 ? { borderTopColor: tokens.borderSubtle } : null]}>
              {row.map((cell, c) => (
                <View key={c} style={styles.tableCell}>
                  <InlineText inlines={cell} ink={tokens.textSecondary} dense />
                </View>
              ))}
            </View>
          ))}
        </View>
      );
  }
}

function ListRow({
  item,
  ordered,
  index,
  ink,
  dense,
  textScale,
}: {
  item: ListItem;
  ordered: boolean;
  index: number;
  ink: string;
  dense: boolean;
  textScale: number;
}) {
  return (
    <View style={styles.listRow}>
      <InlineText inlines={item.inlines} ink={ink} dense={dense} textScale={textScale} marker={ordered ? `${index}.  ` : "•  "} />
      {item.sub !== null ? (
        <View style={styles.listSub}>
          <InlineText inlines={item.sub} ink={ink} dense marker="–  " />
        </View>
      ) : null}
    </View>
  );
}

// ── the inline renderer (nested <Text> = native inline flow) ────────────────

function InlineText({
  inlines,
  ink,
  dense,
  textScale,
  headingTier: tier,
  marker,
}: {
  inlines: Inline[];
  ink: string;
  dense?: boolean;
  textScale?: number;
  headingTier?: HeadingTier;
  marker?: string;
}) {
  // R114-d — the chatTextSize scale rides the PARAGRAPH body (and the dense
  // variant); headings keep their own ladder (R120-CM: the pure headingTier
  // table), and the mono/code tokens the renderer owns stay UNSCALED (the
  // calibration marks).
  const scale = textScale ?? 1;
  const size = tier?.size ?? Math.round((dense ? 13 : 15) * scale);
  const lineHeight =
    tier !== undefined ? Math.round(size * 1.38) : Math.round((dense ? 18.5 : 22) * scale);
  return (
    <Text
      accessibilityRole={tier !== undefined ? "header" : undefined}
      style={{
        color: ink,
        fontSize: size,
        lineHeight,
        fontFamily:
          tier !== undefined
            ? tier.weight === 700
              ? fontFamily.bold
              : fontFamily.semibold
            : fontFamily.regular,
      }}
    >
      {marker}
      {inlines.map((tok, i) => (
        <InlineToken key={i} tok={tok} dense={dense} />
      ))}
    </Text>
  );
}

function InlineToken({ tok, dense }: { tok: Inline; dense?: boolean }) {
  const { tokens } = useTheme();
  switch (tok.t) {
    case "text":
      return <Text>{tok.v}</Text>;
    case "bold":
      return (
        <Text style={{ fontFamily: fontFamily.bold }}>
          {tok.c.map((c, i) => (
            <InlineToken key={i} tok={c} dense={dense} />
          ))}
        </Text>
      );
    case "italic":
      return (
        <Text style={{ fontStyle: "italic" }}>
          {tok.c.map((c, i) => (
            <InlineToken key={i} tok={c} dense={dense} />
          ))}
        </Text>
      );
    case "strike":
      return (
        <Text style={{ textDecorationLine: "line-through", color: tokens.textTertiary }}>
          {tok.c.map((c, i) => (
            <InlineToken key={i} tok={c} dense={dense} />
          ))}
        </Text>
      );
    case "code":
      return (
        <Text
          style={{
            fontFamily: fontFamily.mono,
            fontSize: dense ? 11.5 : 13,
            color: tokens.monoText,
            backgroundColor: tokens.monoBg,
          }}
        >
          {tok.v}
        </Text>
      );
    case "link":
      return (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`link: ${tok.text}`}
          onPress={() => {
            void Linking.openURL(tok.href).catch((err) => {
              mobWarn("markdown", "link open failed", { href: tok.href, err: String(err) });
            });
          }}
        >
          <Text style={{ color: tokens.accent, textDecorationLine: "underline" }}>{tok.text}</Text>
        </Pressable>
      );
  }
}

const styles = StyleSheet.create({
  root: { gap: spacing.sm },
  heading: { marginTop: spacing.sm },
  codeBlock: {
    borderRadius: RADIUS_INPUT,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    marginVertical: spacing.xs,
  },
  codeLang: {
    fontFamily: fontFamily.mono,
    fontSize: TYPE_MICRO,
    letterSpacing: 0.6,
    marginBottom: spacing.xs,
  },
  codeLine: {
    fontFamily: fontFamily.mono,
    fontSize: 12.5,
    lineHeight: 18.5,
  },
  quote: {
    borderLeftWidth: 3,
    paddingLeft: spacing.md,
    paddingVertical: 2,
  },
  list: { gap: 6 },
  listRow: {},
  listSub: { paddingLeft: spacing.md, paddingTop: 2 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: "hidden" },
  tableRow: { flexDirection: "row" },
  tableHead: { borderBottomWidth: StyleSheet.hairlineWidth },
  tableCell: { flex: 1, padding: spacing.sm },
});
