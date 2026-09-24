// Launcher for hosts that validate the "entry file" against the repository
// contents at save time: dist/ is build output (git-ignored), so it does not
// exist in the repo, but this file does. It simply starts the compiled server.
require("./dist/index.js");
