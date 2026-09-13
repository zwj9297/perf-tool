// @ts-check
import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**'] },

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  /* 类型感知规则只挂在 .ts 上：eslint.config.js 自身不在任何 tsconfig 的 include 里，
     全局开启 projectService 会让它报「文件不属于任何项目」 */
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /* 这个代码库里漏 await 的后果是静默的——优化步骤被跳过、
         git 提交还没落盘就继续往下走。这两条是主要防线 */
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      /* 配合 verbatimModuleSyntax：类型只用 import type 引入，
         否则产物里会留下对不存在绑定的运行时导入 */
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  /* 必须放最后：关掉所有与 Prettier 冲突的格式类规则 */
  prettier,
)
