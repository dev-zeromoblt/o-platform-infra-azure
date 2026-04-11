import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  transform: {
    "^.+\\.ts$": "ts-jest",
  },
  coverageDirectory: "coverage",
  collectCoverageFrom: [
    "deployments/**/*.ts",
    "index.ts",
    "!**/node_modules/**",
    "!bin/**",
  ],
  coverageReporters: ["text", "lcov", "cobertura"],
  reporters: [
    "default",
    ["jest-junit", {
      outputDirectory: "test-results",
      outputName: "junit.xml",
    }],
  ],
  testTimeout: 60000,
  watchman: false,
  forceExit: true,
};

export default config;
