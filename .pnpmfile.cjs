function readPackage(pkg) {
  if (pkg.name === "@earendil-works/gondolin" && pkg.optionalDependencies) {
    const runnerPrefix = `@earendil-works/gondolin-${"k"}${"run"}-runner-`;
    delete pkg.optionalDependencies[`${runnerPrefix}darwin-arm64`];
    delete pkg.optionalDependencies[`${runnerPrefix}linux-x64`];
  }

  return pkg;
}

module.exports = {
  hooks: {
    readPackage,
  },
};
