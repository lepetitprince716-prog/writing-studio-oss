import { createElement, Fragment, useMemo, type ReactNode } from 'react';
import { marked, type Token, type Tokens } from 'marked';

const LOCAL_BASE = 'https://writing-studio.invalid/';
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function safeHref(href: string): string | null {
  try {
    const parsed = new URL(href, LOCAL_BASE);
    return SAFE_PROTOCOLS.has(parsed.protocol) ? href : null;
  } catch {
    return null;
  }
}

function renderTokens(tokens: readonly Token[], scope: string): ReactNode[] {
  return tokens.map((token, index) => renderToken(token, `${scope}-${index}`));
}

function renderCell(cell: Tokens.TableCell, key: string): ReactNode {
  const tag = cell.header ? 'th' : 'td';
  return createElement(
    tag,
    {
      key,
      style: cell.align ? { textAlign: cell.align } : undefined,
    },
    renderTokens(cell.tokens, key),
  );
}

function renderToken(token: Token, key: string): ReactNode {
  switch (token.type) {
    case 'space':
    case 'def':
      return null;
    case 'hr':
      return <hr key={key} />;
    case 'br':
      return <br key={key} />;
    case 'heading': {
      const heading = token as Tokens.Heading;
      const depth = Math.min(6, Math.max(1, heading.depth));
      return createElement(`h${depth}`, { key }, renderTokens(heading.tokens, key));
    }
    case 'paragraph': {
      const paragraph = token as Tokens.Paragraph;
      return <p key={key}>{renderTokens(paragraph.tokens, key)}</p>;
    }
    case 'text': {
      const text = token as Tokens.Text;
      return (
        <Fragment key={key}>
          {text.tokens ? renderTokens(text.tokens, key) : text.text}
        </Fragment>
      );
    }
    case 'escape':
      return <Fragment key={key}>{(token as Tokens.Escape).text}</Fragment>;
    case 'strong': {
      const strong = token as Tokens.Strong;
      return <strong key={key}>{renderTokens(strong.tokens, key)}</strong>;
    }
    case 'em': {
      const emphasis = token as Tokens.Em;
      return <em key={key}>{renderTokens(emphasis.tokens, key)}</em>;
    }
    case 'del': {
      const deleted = token as Tokens.Del;
      return <del key={key}>{renderTokens(deleted.tokens, key)}</del>;
    }
    case 'codespan':
      return <code key={key}>{(token as Tokens.Codespan).text}</code>;
    case 'code': {
      const code = token as Tokens.Code;
      return (
        <pre key={key}>
          <code className={code.lang ? `language-${code.lang}` : undefined}>{code.text}</code>
        </pre>
      );
    }
    case 'blockquote': {
      const quote = token as Tokens.Blockquote;
      return <blockquote key={key}>{renderTokens(quote.tokens, key)}</blockquote>;
    }
    case 'list': {
      const list = token as Tokens.List;
      const items = list.items.map((item, index) => (
        <li key={`${key}-item-${index}`}>
          {renderTokens(item.tokens, `${key}-item-${index}`)}
        </li>
      ));
      return list.ordered
        ? <ol key={key} start={typeof list.start === 'number' ? list.start : undefined}>{items}</ol>
        : <ul key={key}>{items}</ul>;
    }
    case 'table': {
      const table = token as Tokens.Table;
      return (
        <div className="md-table-wrap" key={key}>
          <table>
            <thead>
              <tr>
                {table.header.map((cell, index) => renderCell(cell, `${key}-head-${index}`))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={`${key}-row-${rowIndex}`}>
                  {row.map((cell, cellIndex) => renderCell(cell, `${key}-${rowIndex}-${cellIndex}`))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'link': {
      const link = token as Tokens.Link;
      const href = safeHref(link.href);
      const body = renderTokens(link.tokens, key);
      if (!href) return <span key={key}>{body}</span>;
      const external = /^(?:https?:|\/\/)/i.test(href);
      return (
        <a
          key={key}
          href={href}
          title={link.title ?? undefined}
          {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
        >
          {body}
        </a>
      );
    }
    case 'image': {
      const image = token as Tokens.Image;
      return (
        <span className="md-image-alt" key={key} title={image.title ?? undefined}>
          {image.text ? `［图片：${image.text}］` : '［图片］'}
        </span>
      );
    }
    case 'checkbox': {
      const checkbox = token as Tokens.Checkbox;
      return (
        <input
          className="md-task-checkbox"
          key={key}
          type="checkbox"
          checked={checkbox.checked}
          readOnly
          tabIndex={-1}
          aria-label={checkbox.checked ? '已完成' : '未完成'}
        />
      );
    }
    case 'html': {
      // Canon Markdown may contain literal HTML. Display it as inert source
      // text instead of injecting it into the DOM.
      const html = token as Tokens.HTML;
      return html.block
        ? <pre className="md-raw-html" key={key}>{html.text}</pre>
        : <code className="md-raw-html" key={key}>{html.text}</code>;
    }
    default: {
      const generic = token as Token & { tokens?: Token[]; raw?: string };
      return (
        <Fragment key={key}>
          {generic.tokens ? renderTokens(generic.tokens, key) : (generic.raw ?? '')}
        </Fragment>
      );
    }
  }
}

export function SafeMarkdown({ markdown }: { markdown: string }): React.JSX.Element {
  const tokens = useMemo(() => marked.lexer(markdown, { gfm: true }), [markdown]);
  return <>{renderTokens(tokens, 'markdown')}</>;
}
