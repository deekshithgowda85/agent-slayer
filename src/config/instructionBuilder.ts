import { Config } from './index';

interface Instruction { text: string; }

const STACK_RULES: Record<Config['stack'], string> = {
  fastapi: 'FastAPI+Python3.11, AsyncSQLAlchemy, Pydantic v2, JWT, pytest',
  django:  'Django4, DRF, Django ORM, pytest-django, SimpleJWT',
  flask:   'Flask, SQLAlchemy, Marshmallow, pytest, Flask-JWT-Extended',
  nodejs:  'Express+TypeScript, Prisma, Jest, JWT',
};

const FRONTEND_RULES: Record<Config['frontendFramework'], string> = {
  none:   'None (backend-only)',
  react:  'React+TypeScript, component composition, hooks, avoid prop drilling, prefer React Query',
  nextjs: 'Next.js+TypeScript, App Router, server/client components, server actions where appropriate',
  vue:    'Vue 3+TypeScript, Composition API, Pinia, component-driven UI',
  angular:'Angular+TypeScript, standalone components, RxJS best practices, strict templates',
};

const DB_RULES: Record<Config['database'], string> = {
  postgresql: 'AsyncSQLAlchemy+psycopg3, parameterized only, no SELECT *',
  mysql:      'AsyncSQLAlchemy+aiomysql, parameterized only, no SELECT *',
  mongodb:    'Motor async, always scope by org field, no raw queries',
  sqlite:     'SQLAlchemy sync, dev/test only, parameterized queries',
};

const CICD_RULES: Record<string, string> = {
  github:   'GitHub Actions (.github/workflows/*.yml)',
  gitlab:   'GitLab CI (.gitlab-ci.yml)',
  jenkins:  'Jenkinsfile (declarative pipeline)',
  circleci: 'CircleCI (.circleci/config.yml)',
  azure:    'Azure Pipelines (azure-pipelines.yml)',
};

const TEST_RULES: Record<Config['testFramework'], string> = {
  pytest:   'pytest+pytest-asyncio, mock externals, AAA pattern',
  jest:     'Jest+supertest, mock externals, AAA pattern',
  unittest: 'unittest+AsyncMock, mock externals, AAA pattern',
};

const UNIVERSAL: Instruction[] = [
  { text: 'type hints always, async/await all IO, max 40 lines/fn' },
  { text: 'routers/=routes only, crud.py=DB, schemas/=Pydantic, services/=business logic' },
  { text: 'secrets via os.getenv() only, validate all inputs, no print() in prod' },
  { text: 'no SELECT *, no raw unparameterized SQL, no global mutable state' },
];

export function buildCodeInstructions(config: Config): Instruction[] {
  const instructions: Instruction[] = [
    { text: `STACK: ${STACK_RULES[config.stack]}` },
    ...(config.frontendFramework !== 'none'
      ? [{ text: `FRONTEND: ${FRONTEND_RULES[config.frontendFramework]}` }]
      : []),
    { text: `DB: ${DB_RULES[config.database]}` },
    ...UNIVERSAL,
  ];

  if (config.multiTenant) {
    instructions.push({
      text: `MULTITENANT: always filter by ${config.orgIdField}, inject from JWT never from request body`,
    });
  }

  if (config.strictErrorFormat) {
    instructions.push({
      text: 'ERRORS: always return {error:str, code:int, detail:str}, never expose stack traces to client',
    });
  }

  if (config.cicd && config.cicd.length > 0) {
    const cicdStr = config.cicd
      .map(c => CICD_RULES[c] ?? c)
      .join(', ');
    instructions.push({
      text: `CI/CD: generate pipeline files for ${cicdStr}`,
    });
  }

  return instructions;
}

export function buildTestInstructions(config: Config): Instruction[] {
  return [
    { text: `TEST: ${TEST_RULES[config.testFramework]}, cover: happy path, 401, 403, 404, 422, edge cases` },
    { text: 'use factories for test data, never real DB, mock all external APIs and services' },
  ];
}

export function buildReviewInstructions(config: Config): Instruction[] {
  const base = 'review: SQL injection, missing auth, hardcoded secrets, missing validation, N+1 queries';
  const mt = config.multiTenant ? `, missing ${config.orgIdField} scope, cross-org data leak` : '';
  return [
    { text: `${base}${mt}` },
    { text: 'output: CRITICAL/HIGH/MEDIUM/LOW severity + one-line fix per issue' },
  ];
}

export const COMMIT_INSTRUCTION: Instruction = {
  text: 'commits: feat|fix|docs|refactor|test|chore(scope): msg, max 72 chars, imperative mood',
};
