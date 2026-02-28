import * as vscode from 'vscode';
import { SymbolKindObj } from './util';

let statusBarItem: vscode.StatusBarItem;

// 配置项类型定义（方便代码提示）
interface DartReferenceCounterConfig {
  enabled: boolean;
  SymbolKind: number[];
}

// 激活插件时的入口
export function activate(context: vscode.ExtensionContext) {
  // ========== 1. 创建状态栏项 ==========
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left, // 位置：右侧（Left 为左侧）
    0, // 优先级（数值越大越靠右/左）
  );

  // ========== 2. 配置状态栏样式和内容 ==========
  statusBarItem.text = '$(tag) dart'; // 文本 + 内置图标（tag 是标签图标）
  const tooltip = new vscode.MarkdownString(
    `
 ### dart-code-lens

 统计dart函数引用次数
    `,
    true,
  );

  tooltip.isTrusted = true;

  statusBarItem.tooltip = tooltip;
  // statusBarItem.command = 'dart-code-lens.countReferences'; // 点击触发的命令

  // ========== 3. 显示状态栏 ==========
  // statusBarItem.show();

  // 注册 CodeLens 提供者
  const codeLensProvider = vscode.languages.registerCodeLensProvider(
    { language: 'dart', scheme: 'file' },
    new DartFunctionCodeLensProvider(),
  );

  context.subscriptions.push(codeLensProvider);
}

class DartFunctionCodeLensProvider implements vscode.CodeLensProvider {
  // 缓存引用数（优化性能）
  private referenceCache = new Map<string, number>();
  private cacheExpireTime = 5000; // 缓存5秒
  private cacheTimestamps = new Map<string, number>();

  private config: DartReferenceCounterConfig = {
    enabled: true,
    SymbolKind: [SymbolKindObj['Class'], SymbolKindObj['Method'], SymbolKindObj['Function']],
  };
  /**
   * 获取当前文档的配置项
   */
  private getConfig(document: vscode.TextDocument) {
    const config = vscode.workspace.getConfiguration('dartCodeLens', document.uri);
    this.config.enabled = config.get<boolean>('enabled', true);
    this.config.SymbolKind.length = 0;
    const SymbolKind2 = config.get<string[]>('SymbolKind', ['Class', 'Method', 'Function']);

    SymbolKind2.forEach((el) => {
      if (SymbolKindObj[el] !== undefined) {
        this.config.SymbolKind.push(SymbolKindObj[el]);
      }
    });
  }

  /**
   * 递归提取所有函数/方法符号（SymbolKind.Function | SymbolKind.Method）
   */
  private extractAllFunctions(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
    const functions: vscode.DocumentSymbol[] = [];
    if (this.config.SymbolKind.length === 0) {
      return functions;
    }
    for (const symbol of symbols) {
      // 匹配函数（全局函数）或方法（类中的函数）
      // console.log(symbol);
      if (this.config.SymbolKind.includes(symbol.kind)) {
        functions.push(symbol);
      }
      // 递归处理子符号（比如类中的方法、嵌套函数）
      if (symbol.children.length > 0) {
        functions.push(...this.extractAllFunctions(symbol.children));
      }
    }
    return functions;
  }

  async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    const codeLenses: vscode.CodeLens[] = [];

    this.getConfig(document);

    if (!this.config.enabled) {
      return [];
    }

    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      document.uri,
    );
    // console.log('symbols', symbols);
    if (symbols && !token.isCancellationRequested) {
      // 2. 递归提取所有函数/方法符号（包含类中的方法）
      const functionSymbols = this.extractAllFunctions(symbols);

      // console.log('functionSymbols', functionSymbols);
      for (const func of functionSymbols) {
        // 跳过取消请求
        if (token.isCancellationRequested) {
          break;
        }

        // 函数名的精准位置（CodeLens显示在函数名上方/行首）
        // func.range 是函数的完整范围，func.selectionRange 是函数名的精准范围
        const funcNameRange = func.selectionRange;
        // CodeLens显示在函数名所在行的最左侧
        const codeLensPosition = new vscode.Position(funcNameRange.start.line, 0);
        const codeLensRange = new vscode.Range(codeLensPosition, codeLensPosition);
        // 4. 生成唯一缓存key（基于函数名的精准位置）
        const cacheKey = `${funcNameRange.start.line}-${funcNameRange.start.character}`;

        // 2. 获取引用次数（带缓存）
        let refCount = 0;
        // console.log('startPos', match.index, startPos, range);
        try {
          refCount = await this.getReferenceCount(document, funcNameRange.start, cacheKey);
        } catch (e) {
          console.error('获取引用失败:', e);
          refCount = -1;
        }

        // 3. 构建 CodeLens
        const codeLens = new vscode.CodeLens(codeLensRange);
        codeLens.command = {
          title: refCount === -1 ? '' : `${refCount} 个引用`,
          command: 'editor.action.findReferences',
          arguments: [document.uri, funcNameRange.start], // 点击跳转到引用列表
        };
        codeLenses.push(codeLens);
      }
    }

    return codeLenses;
  }

  // 核心方法：获取函数引用次数（通用方案，不依赖 Dart LSP 内部 API）
  private async getReferenceCount(
    document: vscode.TextDocument,
    position: vscode.Position,
    cacheKey: string,
  ): Promise<number> {
    // 1. 检查缓存
    const now = Date.now();
    const cacheTime = this.cacheTimestamps.get(cacheKey);
    if (cacheTime && now - cacheTime < this.cacheExpireTime) {
      return this.referenceCache.get(cacheKey) || 0;
    }

    // 2. 调用 VS Code 内置的查找引用 API（通用方式）
    const references = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeReferenceProvider', // 内置命令，所有语言都支持
      document.uri,
      position,
    );

    // 3. 统计引用次数（排除自身定义）
    let count = 0;
    // console.log('references', references);
    if (references && references.length > 0) {
      // 过滤掉函数自身的定义行
      // console.log('references.length', references.length);
      count = references.filter((ref) => {
        return !(ref.uri.toString() === document.uri.toString() && ref.range.start.line === position.line);
      }).length;
    }

    return count;
  }

  resolveCodeLens?(codeLens: vscode.CodeLens): vscode.CodeLens {
    return codeLens;
  }
}

export function deactivate() {}
