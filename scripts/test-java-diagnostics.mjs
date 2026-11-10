// Java 规则检查：插件没有内置 Java 编译器，只验证「标点层面」的明显语法问题。
// 重点钉住两件事：该报的要报（括号 / 字符串 / 分号 / 控制语句括号），
// 不该报的不报（字符串、注释里的括号，正常的 for/while/if，跨行表达式）。
// 用法：node scripts/test-java-diagnostics.mjs
import { checkJava } from '../src/shared/java-diagnostics.ts';
import { checkCode, checkLanguage, isCheckableLanguage } from '../src/background/compile.ts';

const check = (label, ok, detail) => {
  if (!ok) {
    const extra = detail === undefined ? '' : `（实际：${JSON.stringify(detail).slice(0, 400)}）`;
    throw new Error(`✗ ${label}${extra}`);
  }
  console.log(`✓ ${label}`);
};

const lineOf = (text, offset) => text.slice(0, offset).split('\n').length;

/* ---------- 正常代码：一条都不能报 ---------- */

const normal = `import java.util.Scanner;

public class Main {
    // 注释里的 } { ( ) [ ] 都不算代码
    /* 块注释里的 [ ] 也不算 */
    String text = "{}[]()";
    char brace = '}';

    static int add(int a, int b) {
        return a + b;
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int n = sc.nextInt();
        for (int i = 0; i < n; i++) {
            if (i % 2 == 0) {
                System.out.println(i);
            }
        }
        while (n > 0) {
            n--;
        }
    }
}
`;
check('正常 Java 代码 0 诊断', checkJava(normal).length === 0, checkJava(normal));

const literalsOnly = `public class Main {
    // } { ( [ 注释里的括号不算
    String a = "}{()[]";
    char b = '}';
    /* { [ ( */
}
`;
check('字符串和注释里的括号不参与配对', checkJava(literalsOnly).length === 0, checkJava(literalsOnly));

const textBlock = `public class Main {
    String text = """
        { } ( ) 都不是代码
        """;
}
`;
check('文本块（三引号）里的括号不算', checkJava(textBlock).length === 0, checkJava(textBlock));

/* ---------- 该报的：括号 / 字符串 / 分号 / 控制语句 ---------- */

const missingBraceSource = `public class Main {
    void run() {
}
`;
const missingBrace = checkJava(missingBraceSource);
check(
  '未配对的 { 能报出来，位置在左花括号上',
  missingBrace.length === 1
    && missingBrace[0].message.includes("缺少与 '{' 配对的 '}'")
    && lineOf(missingBraceSource, missingBrace[0].from) === 1,
  missingBrace,
);

const missingParenSource = `public class Main {
    void run() {
        if (x > 0 {
            x--;
        }
    }
}
`;
const missingParen = checkJava(missingParenSource);
check(
  '未配对的 ( 能报出来',
  missingParen.length === 1
    && missingParen[0].message.includes("缺少与 '(' 配对的 ')'")
    && lineOf(missingParenSource, missingParen[0].from) === 3,
  missingParen,
);

const extraBraceSource = `public class Main {
    void run() {
        int x = 1;
    }
}
}
`;
const extraBrace = checkJava(extraBraceSource);
check(
  '多出来的 } 能报出来',
  extraBrace.length === 1
    && extraBrace[0].message.includes("多余的 '}'")
    && lineOf(extraBraceSource, extraBrace[0].from) === 6,
  extraBrace,
);

const missingSquareSource = 'int[] values = new int[3;\n';
const missingSquare = checkJava(missingSquareSource);
check(
  '未配对的 [ 能报出来',
  missingSquare.length === 1 && missingSquare[0].message.includes("缺少与 '[' 配对的 ']'"),
  missingSquare,
);

const badStringSource = `public class Main {
    String text = "abc;
}
`;
const badString = checkJava(badStringSource);
check(
  '未闭合的字符串能报出来',
  badString.length === 1
    && badString[0].message.includes('字符串没有闭合')
    && lineOf(badStringSource, badString[0].from) === 2,
  badString,
);

const badCharSource = `public class Main {
    char c = 'x;
}
`;
const badChar = checkJava(badCharSource);
check(
  '未闭合的字符常量能报出来',
  badChar.length === 1 && badChar[0].message.includes('字符常量没有闭合'),
  badChar,
);

const missingSemicolonSource = `public class Main {
    int value = 5
}
`;
const missingSemicolon = checkJava(missingSemicolonSource);
check(
  '声明赋值行缺分号能报出来',
  missingSemicolon.length === 1
    && missingSemicolon[0].message.includes('分号')
    && lineOf(missingSemicolonSource, missingSemicolon[0].from) === 2,
  missingSemicolon,
);

const missingReturnSemicolonSource = `public class Main {
    int add(int a, int b) {
        return a + b
    }
}
`;
const missingReturnSemicolon = checkJava(missingReturnSemicolonSource);
check(
  'return 语句缺分号能报出来',
  missingReturnSemicolon.length === 1 && missingReturnSemicolon[0].message.includes('return'),
  missingReturnSemicolon,
);

const noIfParenSource = `public class Main {
    void run() {
        if x > 0 {
            x--;
        }
    }
}
`;
const noIfParen = checkJava(noIfParenSource);
check(
  'if 后面缺括号能报出来',
  noIfParen.length === 1 && noIfParen[0].message.includes('if 后面缺少括号'),
  noIfParen,
);

/* ---------- 不该报的：跨行表达式 ---------- */

const continuation = `public class Main {
    int value = 1
        + 2;
    String text = new StringBuilder()
        .append("a")
        .toString();
    int sum(int a, int b) {
        return a
            + b;
    }
}
`;
check('跨行表达式不误报缺分号', checkJava(continuation).length === 0, checkJava(continuation));

/* ---------- 与 checkCode / 语言识别接起来 ---------- */

const checked = await checkCode('public class Main {\n    int value = 5\n}\n', 'Java');
check(
  'checkCode 的 Java 分支写明「无内置编译器，仅规则检查」',
  checked.ok === true
    && checked.note === 'Java 无内置编译器，仅规则检查'
    && checked.errorCount === 1
    && checked.diagnostics.length === 1
    && typeof checked.diagnostics[0].from === 'number'
    && typeof checked.diagnostics[0].to === 'number'
    && typeof checked.diagnostics[0].advice === 'string',
  checked,
);

const checkedClean = await checkCode(normal, 'Java (javac 17)');
check(
  'checkCode 的 Java 正常代码 0 诊断',
  checkedClean.ok === true && checkedClean.note === 'Java 无内置编译器，仅规则检查' && checkedClean.errorCount === 0,
  checkedClean,
);

// 行尾是 CRLF 时 from/to 仍按原文算，不能让波浪线整体偏一列
const crlfSource = 'public class Main {\r\n    int x = 1\r\n}\r\n';
const crlf = checkJava(crlfSource);
check(
  'CRLF 代码的诊断范围能直接切到原文',
  crlf.length === 1 && crlfSource.slice(crlf[0].from, crlf[0].to) === 'int x = 1',
  crlf,
);

check(
  '语言标记识别：Java 算、JavaScript 不算',
  checkLanguage('Java') === 'java'
    && checkLanguage('Java (javac 17)') === 'java'
    && checkLanguage('JavaScript') === null,
);
check('isCheckableLanguage 认 Java', isCheckableLanguage('Java'));

console.log('\nJava 规则检查校验通过');
