import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const addProperty = (component, name, value) => {
  const properties = component.properties ?? [];
  const filtered = properties.filter((property) => property.name !== name);
  filtered.push({ name, value: String(value) });
  component.properties = filtered;
};

export const normalizeLocalSourceBuiltReferences = ({ sbom, checkoutRoot, recipes }) => {
  const recipesByName = new Map(recipes.map((recipe) => [recipe.name, recipe]));
  const application = sbom.metadata?.component;
  if (application) {
    const versionSuffix = application.version ? `@${application.version}` : "";
    if (
      !versionSuffix ||
      typeof application["bom-ref"] !== "string" ||
      !application["bom-ref"].endsWith(versionSuffix)
    ) {
      throw new Error("SBOM application component has no stable package identity");
    }
    application.name = application["bom-ref"].slice(0, -versionSuffix.length);
  }
  for (const component of sbom.components ?? []) {
    const recipe = recipesByName.get(component.name);
    let sourceBuiltReferenceCount = 0;
    for (const reference of component.externalReferences ?? []) {
      if (typeof reference.url !== "string" || !/^file:/i.test(reference.url)) continue;
      if (!recipe || component.version !== recipe.version) {
        throw new Error(
          `SBOM local file reference is not an exact source-built recipe: ${component.name}@${component.version}`,
        );
      }
      let referencedPath;
      try {
        referencedPath = fileURLToPath(new URL(reference.url));
      } catch {
        throw new Error(`SBOM has an invalid absolute file URL: ${reference.url}`);
      }
      const expectedPath = join(
        checkoutRoot,
        ".cache",
        "vendor",
        "artifacts",
        recipe.artifact.filename,
      );
      if (resolve(referencedPath) !== resolve(expectedPath)) {
        throw new Error(
          `SBOM local file reference does not map to ${recipe.artifact.filename}: ${reference.url}`,
        );
      }
      reference.url = `urn:sha256:${recipe.artifact.sha256}`;
      sourceBuiltReferenceCount += 1;
    }
    if (sourceBuiltReferenceCount) {
      addProperty(component, "dicekeys:source-built-replacement", "true");
      addProperty(component, "dicekeys:source-commit", recipe.commit);
      addProperty(component, "dicekeys:artifact-sha256", recipe.artifact.sha256);
      addProperty(component, "dicekeys:package-tree-sha256", recipe.artifact.packageTreeSha256);
      addProperty(component, "dicekeys:published-byte-equivalence-claimed", "false");
    }
  }

  const inspectStrings = (value) => {
    if (typeof value === "string") {
      if (/^file:(?:\/|[A-Za-z]:)/i.test(value) || value.includes(resolve(checkoutRoot))) {
        throw new Error(`normalized SBOM retains an absolute checkout path: ${value}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) inspectStrings(entry);
    } else if (value && typeof value === "object") {
      for (const entry of Object.values(value)) inspectStrings(entry);
    }
  };
  inspectStrings(sbom);
  return sbom;
};
