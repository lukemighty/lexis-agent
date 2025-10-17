export async function robustSelect(page, labelRegex, value) {
  try {
    console.log(`[robustSelect] selecting "${value}" for`, labelRegex);

    // 1) Preferred: field by accessible label (works if form uses proper labels)
    const field = page.getByLabel(labelRegex).first();
    if (await field.count()) {
      await field.click({ force: true });
      await field.fill("");               // clear existing
      await field.type(value, { delay: 35 });
      // common listbox options
      const optByRole = page.getByRole("option", { name: new RegExp(`^${value}$`, "i") }).first();
      const optByText = page.locator(`text=${value}`).first();
      if (await optByRole.count()) {
        await optByRole.click();
        return true;
      }
      await optByText.waitFor({ state: "visible", timeout: 5000 });
      await optByText.click();
      return true;
    }

    // 2) Fallback: input next to label text (e.g., custom combobox markup)
    const near = page.locator(
      "label:has-text('State') + * input, " +
      "label:has-text('Jurisdiction') + * input"
    ).first();
    if (await near.count()) {
      await near.click({ force: true });
      await near.fill("");
      await near.type(value, { delay: 35 });
      const opt = page.getByRole("option", { name: new RegExp(`^${value}$`, "i") }).first()
                .or(page.locator(`text=${value}`).first());
      await opt.waitFor({ state: "visible", timeout: 5000 });
      await opt.click();
      return true;
    }

    // 3) Last resort: first combobox on page
    const combo = page.getByRole("combobox").first();
    if (await combo.count()) {
      await combo.click({ force: true });
      await combo.type(value, { delay: 35 });
      const opt2 = page.getByRole("option", { name: new RegExp(`^${value}$`, "i") }).first()
                 .or(page.locator(`text=${value}`).first());
      await opt2.waitFor({ state: "visible", timeout: 5000 });
      await opt2.click();
      return true;
    }

    console.warn("[robustSelect] no matching field found for labelRegex");
    return false;
  } catch (err) {
    console.warn(`[robustSelect] failed for "${value}":`, err.message);
    return false;
  }
}
