import { randomUUID, createHash } from "node:crypto";
import { storeState, productInput, movement } from "./device-store.mjs";
const loc = (en, fr) => ({ en, fr });
const pending = loc(
  "Model-specific details will be confirmed before purchase.",
  "Les caractéristiques du modèle seront confirmées avant achat.",
);
export const initialStoreCatalogue = [
  {
    sku: "ND-TPLINK-AX1500",
    name: loc(
      "TP-Link AX1500 Travel Router",
      "Routeur de voyage TP-Link AX1500",
    ),
    stock: 10,
    category: "Travel routers",
    description: loc(
      "Portable TP-Link travel router in the AX1500 class. Exact model, hardware version and connection options will be confirmed before purchase.",
      "Routeur de voyage portable TP-Link de classe AX1500. Le modèle exact, la version matérielle et les connexions seront confirmés avant achat.",
    ),
  },
  {
    sku: "ND-TPLINK-CPE210",
    name: loc("TP-Link CPE210", "TP-Link CPE210"),
    stock: 6,
    category: "Outdoor networking",
    description: loc(
      "Outdoor 2.4 GHz wireless CPE with a directional 9 dBi antenna, designed for point-to-point links and outdoor networking. Wireless rates up to 300 Mbps; passive PoE power. Installation and alignment are required.",
      "CPE extérieur 2,4 GHz avec antenne directionnelle de 9 dBi, destiné aux liaisons point à point et aux réseaux extérieurs. Débit radio jusqu’à 300 Mbit/s ; PoE passif. Installation et orientation nécessaires.",
    ),
  },
  {
    sku: "ND-WAVLINK-AC1200",
    name: loc("Wavlink AC1200", "Wavlink AC1200"),
    stock: 2,
    category: "Wi-Fi extenders",
    description: loc(
      "Wavlink AC1200-class Wi-Fi device. Exact model, operating modes, ports and package contents will be confirmed before purchase.",
      "Appareil Wi-Fi Wavlink de classe AC1200. Le modèle exact, les modes, les ports et le contenu seront confirmés avant achat.",
    ),
  },
  {
    sku: "ND-WAVLINK-MINI",
    name: loc("Wavlink Mini", "Wavlink Mini"),
    stock: 4,
    category: "Wi-Fi extenders",
    description: loc(
      "Compact Wavlink Wi-Fi device. Exact model and technical specifications will be confirmed before purchase.",
      "Appareil Wi-Fi compact Wavlink. Le modèle exact et les caractéristiques techniques seront confirmés avant achat.",
    ),
  },
];
const key = "owner-approved-store-catalogue-20261108-v1";
export async function publishInitialStoreCatalogue({
  store,
  now = () => new Date(),
}) {
  return store.transaction((s) => {
    storeState(s);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(initialStoreCatalogue))
      .digest("hex");
    const prior = s.storeOperations.find((o) => o.key === key);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw Error("Catalogue batch changed; review required.");
      return { applied: false, products: 4, initialUnits: 22 };
    }
    if (
      initialStoreCatalogue.some((row) =>
        s.storeProducts.some(
          (p) => p.sku.toLowerCase() === row.sku.toLowerCase(),
        ),
      )
    )
      throw Error("Catalogue SKU already exists; review required.");
    const at = now(),
      actor = "deployment:owner-approved-store-catalogue";
    for (const row of initialStoreCatalogue) {
      let category = s.storeCategories.find(
        (c) => c.name.en === row.category && !c.hidden,
      );
      if (!category) {
        category = {
          id: randomUUID(),
          version: 1,
          name: loc(
            row.category,
            row.category === "Travel routers"
              ? "Routeurs de voyage"
              : row.category === "Outdoor networking"
                ? "Réseaux extérieurs"
                : "Répéteurs Wi-Fi",
          ),
          hidden: false,
          position: s.storeCategories.length,
        };
        s.storeCategories.push(category);
      }
      const data = productInput(s, {
        ...row,
        categoryId: category.id,
        price: null,
        cost: 0,
        featured: false,
        status: "published",
        images: [],
        specifications: pending,
        compatibility: loc(
          "NDAHI compatibility has not yet been physically verified. Internet service is separate.",
          "La compatibilité NDAHI reste à vérifier sur matériel réel. Le service Internet est séparé.",
        ),
        contents: pending,
        warranty: loc(
          "Warranty terms will be confirmed before purchase.",
          "Les conditions de garantie seront confirmées avant achat.",
        ),
        setup: pending,
      });
      const p = {
        id: randomUUID(),
        ...data,
        stock: 0,
        version: 1,
        createdAt: at.toISOString(),
        updatedAt: at.toISOString(),
      };
      s.storeProducts.push(p);
      movement(
        s,
        p,
        row.stock,
        "Initial stock supplied by owner on 8 November 2026",
        actor,
        at,
        `${key}-${row.sku}`,
      );
    }
    s.storeOperations.push({
      id: randomUUID(),
      key,
      fingerprint,
      at: at.toISOString(),
    });
    s.auditLogs ||= [];
    s.auditLogs.unshift({
      id: randomUUID(),
      actor,
      action: "store.catalogue.published",
      at: at.toISOString(),
      meta: {
        batch: key,
        products: 4,
        initialUnits: 22,
        pricesConfirmed: false,
      },
    });
    return { applied: true, products: 4, initialUnits: 22 };
  });
}
