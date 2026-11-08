/**
 * C 标准库 / math 常用函数的��文速查表。
 *
 * 用途：鼠标停在代码里的函数名上时，弹一条中文说明（v5.0 的「函数中文注释」）。
 *
 * 数据放在共享层而不是页面脚本里，有两个原因：
 *   · 这份表要被**页面里的 MAIN world 脚本**用到（只有它能读到 CodeMirror 的实例），
 *     而 MAIN world 拿不到扩展的模块系统 —— 所以表在这里导出，
 *     由 background 在注入脚本时用 JSON 塞进去（单一数据源，不会两处漂移）。
 *   · 表本身是纯数据，可以在 Node 里直接单测（名字对不对、有没有重复、有没有漏注释）。
 */

export interface CFunctionDoc {
  /** 函数原型（简写，够用就行） */
  readonly signature: string;
  /** 一句话说明它做什么 */
  readonly summary: string;
  /** 容易踩的坑 / 注意事项 */
  readonly note?: string;
}

/** 函数名 → 中文说明 */
export const C_LIBRARY_DOCS: Readonly<Record<string, CFunctionDoc>> = {
  /* ---------- stdio.h ---------- */
  printf: {
    signature: 'int printf(const char *format, ...)',
    summary: '按格式串把内容打印到标准输出（屏幕）。',
    note: '返回打印的字符数；负数表示出错。格式串里 %d %f %s %c 分别对应整数、浮点、字符串、字符。',
  },
  scanf: {
    signature: 'int scanf(const char *format, ...)',
    summary: '按格式串从标准输入（键盘）读数据，填进后面的变量地址。',
    note: '变量要写 & 取地址，例如 scanf("%d", &n)；读单个字符用 %c 更稳。',
  },
  puts: {
    signature: 'int puts(const char *s)',
    summary: '把字符串打印到屏幕并自动换行。',
    note: '比 printf("%s\\n", s) 省事，但没法格式化。',
  },
  putchar: {
    signature: 'int putchar(int c)',
    summary: '输出一个字符。',
  },
  getchar: {
    signature: 'int getchar(void)',
    summary: '从标准输入读一个字符。',
    note: '读的是字节不是数字，读数字要用 scanf。',
  },
  fopen: {
    signature: 'FILE *fopen(const char *path, const char *mode)',
    summary: '打开文件，返回文件指针。',
    note: 'mode：r 只读、w 写（会清空原文件）、a 追加、r+ 读写；失败返回 NULL。',
  },
  fclose: {
    signature: 'int fclose(FILE *fp)',
    summary: '关闭文件并把缓冲区里的内容写回磁盘。',
    note: '不关文件可能丢数据，读完记得关。',
  },
  fread: {
    signature: 'size_t fread(void *ptr, size_t size, size_t count, FILE *fp)',
    summary: '从文件里读 count 个 size 字节的数据块。',
  },
  fwrite: {
    signature: 'size_t fwrite(const void *ptr, size_t size, size_t count, FILE *fp)',
    summary: '把 count 个 size 字节的数据块写进文件。',
  },
  fgets: {
    signature: 'char *fgets(char *s, int size, FILE *fp)',
    summary: '从文件读一整行（含换行符）到字符数组。',
    note: '比 fscanf("%s") 安全，不会因空格截断；注意它会保留行尾换行。',
  },
  fputs: {
    signature: 'int fputs(const char *s, FILE *fp)',
    summary: '把字符串写进文件（不自动换行）。',
  },
  fseek: {
    signature: 'int fseek(FILE *fp, long offset, int whence)',
    summary: '把文件位置指针移到指定位置。',
    note: 'whence：SEEK_SET 从头、SEEK_CUR 从当前位置、SEEK_END 从末尾。',
  },
  ftell: {
    signature: 'long ftell(FILE *fp)',
    summary: '返回当前文件位置指针离文件头的字节数。',
  },
  rewind: {
    signature: 'void rewind(FILE *fp)',
    summary: '把文件位置指针移回文件开头。',
  },
  feof: {
    signature: 'int feof(FILE *fp)',
    summary: '判断是否已经读到文件末尾。',
  },
  fflush: {
    signature: 'int fflush(FILE *fp)',
    summary: '把输出缓冲区立刻写到文件里。',
  },
  remove: {
    signature: 'int remove(const char *path)',
    summary: '删除一个文件。',
  },
  rename: {
    signature: 'int rename(const char *old, const char *new)',
    summary: '给文件改名。',
  },

  /* ---------- stdlib.h ---------- */
  malloc: {
    signature: 'void *malloc(size_t size)',
    summary: '在堆上申请 size 字节的内存，返回首地址。',
    note: '申请到的内容是未初始化的垃圾值；用完必须 free。',
  },
  calloc: {
    signature: 'void *calloc(size_t count, size_t size)',
    summary: '申请 count × size 字节的内存，并把内容清零。',
  },
  realloc: {
    signature: 'void *realloc(void *ptr, size_t size)',
    summary: '把已申请的内存改成 size 字节，可能换一块新内存。',
    note: '成功返回新指针（要接住！原指针就失效了），失败返回 NULL 且原内存还在。',
  },
  free: {
    signature: 'void free(void *ptr)',
    summary: '释放 malloc / calloc / realloc 申请的内存。',
    note: '只能释放一次，释放后再用这块内存是未定义行为。',
  },
  exit: {
    signature: 'void exit(int status)',
    summary: '结束程序并返回给操作系统一个状态码。',
    note: '会顺带调用 atexit 注册的函数；status 一般用 0 表示正常结束。',
  },
  abort: {
    signature: 'void abort(void)',
    summary: ' abnormal 终止程序（通常是检测到严重错误时用）。',
  },
  atexit: {
    signature: 'int atexit(void (*func)(void))',
    summary: '注册一个在 exit 时自动调用的函数。',
  },
  atoi: {
    signature: 'int atoi(const char *s)',
    summary: '把字符串转成整数。',
    note: '遇到非法字符就停止，不报错；需要严谨转换用 strtol。',
  },
  atol: {
    signature: 'long atol(const char *s)',
    summary: '把字符串转成 long。',
  },
  atof: {
    signature: 'double atof(const char *s)',
    summary: '把字符串转成 double。',
  },
  strtol: {
    signature: 'long strtol(const char *s, char **endptr, int base)',
    summary: '把字符串按指定进制（10、16 等）转成整数，并可取到转换结束的位置。',
  },
  strtod: {
    signature: 'double strtod(const char *s, char **endptr)',
    summary: '把字符串转成 double。',
  },
  rand: {
    signature: 'int rand(void)',
    summary: '产生一个 0 到 RAND_MAX 之间的随机整数。',
  },
  srand: {
    signature: 'void srand(unsigned int seed)',
    summary: '给随机数生成器设定种子，用同一个种子能得到同一串随机数。',
  },
  qsort: {
    signature: 'void qsort(void *base, size_t n, size_t size, int (*cmp)(const void *, const void *))',
    summary: '给数组排序。',
    note: '比较函数里要写强制类型转换，否则元素大于 1 字节时会比较错。',
  },
  bsearch: {
    signature: 'void *bsearch(const void *key, const void *base, size_t n, size_t size, int (*cmp)(const void *, const void *))',
    summary: '在已排序的数组里二分查找一个键。',
  },
  abs: {
    signature: 'int abs(int x)',
    summary: '返回整数的绝对值。',
  },
  labs: {
    signature: 'long labs(long x)',
    summary: '返回 long 的绝对值。',
  },
  getenv: {
    signature: 'char *getenv(const char *name)',
    summary: '读取环境变量，返回字符串或 NULL。',
  },
  system: {
    signature: 'int system(const char *command)',
    summary: '用命令行解释器执行一条系统命令。',
  },

  /* ---------- string.h ---------- */
  strlen: {
    signature: 'size_t strlen(const char *s)',
    summary: '返回字符串的长度（不包括结尾的 \\0）。',
  },
  strcpy: {
    signature: 'char *strcpy(char *dest, const char *src)',
    summary: '把 src 的字符串复制到 dest。',
    note: 'dest 的空间必须够大，且不能和 src 是同一块内存。',
  },
  strncpy: {
    signature: 'char *strncpy(char *dest, const char *src, size_t n)',
    summary: '复制最多 n 个字符。',
    note: '不会自动补 \\0，除非源串比 n 短。',
  },
  strcat: {
    signature: 'char *strcat(char *dest, const char *src)',
    summary: '把 src 接到 dest 后面。',
    note: '同样要保证 dest 空间够大。',
  },
  strncat: {
    signature: 'char *strncat(char *dest, const char *src, size_t n)',
    summary: '把 src 的前 n 个字符接到 dest 后面。',
  },
  strcmp: {
    signature: 'int strcmp(const char *a, const char *b)',
    summary: '比较两个字符串：相等返回 0，a 大返回正数，a 小返回负数。',
    note: '按字典序比较字符，不是按数值。',
  },
  strncmp: {
    signature: 'int strncmp(const char *a, const char *b, size_t n)',
    summary: '只比较两个字符串的前 n 个字符。',
  },
  strchr: {
    signature: 'char *strchr(const char *s, int c)',
    summary: '在字符串里找某个字符第一次出现的位置，找不到返回 NULL。',
  },
  strrchr: {
    signature: 'char *strrchr(const char *s, int c)',
    summary: '在字符串里找某个字符最后一次出现的位置。',
  },
  strstr: {
    signature: 'char *strstr(const char *haystack, const char *needle)',
    summary: '在一个字符串里找另一个字符串（子串），找不到返回 NULL。',
  },
  strtok: {
    signature: 'char *strtok(char *s, const char *delim)',
    summary: '按分隔符把字符串拆成一段段（第一次调用传整串，之后传 NULL）。',
  },
  strspn: {
    signature: 'size_t strspn(const char *s, const char *accept)',
    summary: '返回 s 开头由 accept 里的字符组成的最长前缀长度。',
  },
  strcspn: {
    signature: 'size_t strcspn(const char *s, const char *reject)',
    summary: '返回 s 开头第一个不在 reject 里的字符的位置。',
  },
  strpbrk: {
    signature: 'char *strpbrk(const char *s, const char *accept)',
    summary: '找 s 里第一个出现在 accept 中的字符。',
  },
  memset: {
    signature: 'void *memset(void *s, int c, size_t n)',
    summary: '把内存块的前 n 个字节全设成字符 c。',
    note: '常用来清零数组：memset(a, 0, sizeof(a))。',
  },
  memcpy: {
    signature: 'void *memcpy(void *dest, const void *src, size_t n)',
    summary: '把 src 的前 n 个字节原样复制到 dest。',
    note: '两块内存不能重叠，重叠用 memmove。',
  },
  memmove: {
    signature: 'void *memmove(void *dest, const void *src, size_t n)',
    summary: '复制 n 个字节，源和目标重叠时也正确。',
  },
  memcmp: {
    signature: 'int memcmp(const void *a, const void *b, size_t n)',
    summary: '逐字节比较两块内存的前 n 个字节。',
  },
  memchr: {
    signature: 'void *memchr(const void *s, int c, size_t n)',
    summary: '在前 n 个字节里找某个字符。',
  },

  /* ---------- math.h ---------- */
  sqrt: {
    signature: 'double sqrt(double x)',
    summary: '求平方根。',
    note: '参数为负数时结果是 nan。',
  },
  pow: {
    signature: 'double pow(double x, double y)',
    summary: '求 x 的 y 次方。',
  },
  exp: {
    signature: 'double exp(double x)',
    summary: '求 e 的 x 次方。',
  },
  log: {
    signature: 'double log(double x)',
    summary: '求自然对数（以 e 为底）。',
  },
  log10: {
    signature: 'double log10(double x)',
    summary: '求以 10 为底的对数。',
  },
  log2: {
    signature: 'double log2(double x)',
    summary: '求以 2 为底的对数。',
  },
  sin: {
    signature: 'double sin(double x)',
    summary: '求正弦值（x 用弧度）。',
  },
  cos: {
    signature: 'double cos(double x)',
    summary: '求余弦值（x 用弧度）。',
  },
  tan: {
    signature: 'double tan(double x)',
    summary: '求正切值（x 用弧度）。',
  },
  asin: {
    signature: 'double asin(double x)',
    summary: '求反正弦值，结果在 -π/2 到 π/2 之间。',
  },
  acos: {
    signature: 'double acos(double x)',
    summary: '求反余弦值。',
  },
  atan: {
    signature: 'double atan(double x)',
    summary: '求反正切值。',
  },
  atan2: {
    signature: 'double atan2(double y, double x)',
    summary: '求 y/x 的反正切，参数顺序和 atan(x, y) 相反，且能判断象限。',
  },
  sinh: {
    signature: 'double sinh(double x)',
    summary: '求双曲正弦值。',
  },
  cosh: {
    signature: 'double cosh(double x)',
    summary: '求双曲余弦值。',
  },
  tanh: {
    signature: 'double tanh(double x)',
    summary: '求双曲正切值。',
  },
  ceil: {
    signature: 'double ceil(double x)',
    summary: '向上取整（返回 double）。',
  },
  floor: {
    signature: 'double floor(double x)',
    summary: '向下取整（返回 double）。',
  },
  round: {
    signature: 'double round(double x)',
    summary: '四舍五入到最接近的整数（返回 double）。',
  },
  trunc: {
    signature: 'double trunc(double x)',
    summary: '向零取整，丢掉小数部分。',
  },
  fabs: {
    signature: 'double fabs(double x)',
    summary: '返回浮点数的绝对值。',
  },
  fmod: {
    signature: 'double fmod(double x, double y)',
    summary: '求 x 除以 y 的余数（结果与 x 同号）。',
  },
  hypot: {
    signature: 'double hypot(double x, double y)',
    summary: '求 sqrt(x² + y²)，不会像自己算那样溢出。',
  },
  cbrt: {
    signature: 'double cbrt(double x)',
    summary: '求立方根。',
  },
  ldexp: {
    signature: 'double ldexp(double x, int exp)',
    summary: '返回 x × 2^exp。',
  },
  frexp: {
    signature: 'double frexp(double value, int *exp)',
    summary: '把浮点数拆成尾数和指数：value = 尾数 × 2^指数。',
  },
  modf: {
    signature: 'double modf(double value, double *iptr)',
    summary: '把浮点数拆成整数部分和小数部分。',
  },
  isnan: {
    signature: 'int isnan(double x)',
    summary: '判断 x 是不是 nan（0/0 之类算出来的无效值）。',
  },
  isinf: {
    signature: 'int isinf(double x)',
    summary: '判断 x 是不是无穷大。',
  },
  M_PI: {
    signature: '#define M_PI 3.14159265358979323846',
    summary: '圆周率常量。',
    note: '用 <math.h> 才有这个宏；有些编译器要开 -std=gnu99 或用 M_PI 自己定义。',
  },
  M_E: {
    signature: '#define M_E 2.71828182845904523536',
    summary: '自然对数的底数 e。',
  },
  M_SQRT2: {
    signature: '#define M_SQRT2 1.41421356237309504880',
    summary: '√2 的值。',
  },
  INFINITY: {
    signature: '#define INFINITY',
    summary: '表示无穷大的浮点常量。',
  },
  NAN: {
    signature: '#define NAN',
    summary: '表示无效结果的浮点常量。',
  },
};

/** 查一个函数名的中文说明；不是标准库函数就返回 null */
export function lookupCFunctionDoc(name: string): CFunctionDoc | null {
  return Object.prototype.hasOwnProperty.call(C_LIBRARY_DOCS, name) ? C_LIBRARY_DOCS[name] : null;
}
