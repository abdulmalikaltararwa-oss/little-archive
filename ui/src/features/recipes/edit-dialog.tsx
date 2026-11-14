// Edit a recipe by hand: its title, servings and time, one row for each ingredient and each step, and notes.
// What is saved is the owner's version, kept beside the automatic reading; it always wins and is never merged
// into it. The form is plain rows (no drag and drop): a row can be moved up or down, removed, or added.
import { useId, useRef, useState } from 'react';
import { errorMessage } from '@web/utils.js';
import { cn } from 'cn';
import { ArrowDown, ArrowUp, Check, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { useArchive } from '@/app/archive-context';
import { confirm, DIALOG_EXIT_MS, toast } from '@/app/ui-state';
import { Field, FormError, Whisper } from '@/components/field';
import { Modal } from '@/components/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { rememberFocus } from '@/lib/focus';
import { putRecipe, type Recipe } from './api';
import { buildEdit, emptyIngredient, emptyStep, formFromRecipe, formSignature, MAX_ROWS, moveRow, type FormErrors, type IngredientRow, type RecipeForm, type StepRow } from './edit-form';

// The unit codes the server knows by name. Any other word is kept as the owner wrote it.
const UNITS = ['g', 'kg', 'oz', 'lb', 'ml', 'l', 'tsp', 'tbsp', 'fl oz', 'cup', 'pint', 'quart', 'gallon', 'pinch', 'dash', 'splash', 'drizzle', 'handful', 'clove', 'can', 'jar', 'packet', 'stick', 'slice', 'piece', 'bunch', 'sprig', 'head', 'stalk', 'knob', 'sheet'];

/** A field's problem, in the danger colour, as the field's help line. It is read out when it appears. */
const problemText = (message: string | undefined) => (message ? <span role="alert" className="text-danger">{message}</span> : undefined);

interface RowTools {
  index: number;
  count: number;
  onMove(direction: -1 | 1): void;
  onRemove(): void;
  noun: string;
}

function Tools({ index, count, onMove, onRemove, noun }: RowTools) {
  return (
    <div className="flex items-center">
      <Button variant="ghost" size="icon" className="hit-44 size-9" aria-label={`Move ${noun} ${index + 1} up`} disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp /></Button>
      <Button variant="ghost" size="icon" className="hit-44 size-9" aria-label={`Move ${noun} ${index + 1} down`} disabled={index === count - 1} onClick={() => onMove(1)}><ArrowDown /></Button>
      <Button variant="danger-ghost" size="icon" className="hit-44 size-9" aria-label={`Remove ${noun} ${index + 1}`} onClick={onRemove}><Trash2 /></Button>
    </div>
  );
}

function IngredientEditor({ row, tools, errors, onChange }: { row: IngredientRow; tools: RowTools; errors?: { quantity?: string; name?: string }; onChange(next: IngredientRow): void }) {
  const [more, setMore] = useState(Boolean(row.note || row.group || row.optional));
  const detail = useId();
  const n = tools.index + 1;
  return (
    <li data-row-key={row.key} className="rounded-md border border-line bg-card-2/50 p-3">
      <div className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-2 sm:grid-cols-[5.25rem_7rem_minmax(0,1fr)]">
        <Input aria-label={`Amount, ingredient ${n}`} aria-invalid={errors?.quantity ? true : undefined} inputMode="decimal" placeholder="Amount" value={row.quantity} onChange={event => onChange({ ...row, quantity: event.target.value })} />
        <Input aria-label={`Unit, ingredient ${n}`} list="recipe-units" placeholder="Unit" autoCapitalize="none" className="[&::-webkit-calendar-picker-indicator]:opacity-45 dark:[&::-webkit-calendar-picker-indicator]:invert" value={row.unit} onChange={event => onChange({ ...row, unit: event.target.value })} />
        <Input aria-label={`Name, ingredient ${n}`} aria-invalid={errors?.name ? true : undefined} dir="auto" placeholder="Ingredient" maxLength={200} className="col-span-2 sm:col-span-1" value={row.name} onChange={event => onChange({ ...row, name: event.target.value })} />
      </div>
      {errors?.quantity || errors?.name ? <p role="alert" className="mt-1.5 text-xs text-danger">{errors.name ?? errors.quantity}</p> : null}
      {more ? (
        <div id={detail} className="mt-2 grid gap-2 sm:grid-cols-2">
          <Input aria-label={`Note, ingredient ${n}`} dir="auto" placeholder="Note (chopped, at room temperature)" maxLength={300} value={row.note} onChange={event => onChange({ ...row, note: event.target.value })} />
          <Input aria-label={`Group, ingredient ${n}`} dir="auto" placeholder="Group (for the sauce)" maxLength={80} value={row.group} onChange={event => onChange({ ...row, group: event.target.value })} />
          <label className="flex min-h-11 items-center gap-2.5 text-sm text-ink sm:col-span-2">
            <input type="checkbox" checked={row.optional} onChange={event => onChange({ ...row, optional: event.target.checked })} className="size-[1.15rem] accent-[var(--sage)]" />
            This ingredient is optional
          </label>
        </div>
      ) : null}
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <button type="button" aria-expanded={more} aria-controls={more ? detail : undefined} onClick={() => setMore(value => !value)} className="hit-44 -ms-1 inline-flex items-center gap-1 rounded-sm px-1 py-1 text-xs text-ink-soft hov:text-ink">
          <ChevronRight className={cn('size-3.5 transition-transform duration-200 rtl:rotate-180', more && 'rotate-90 rtl:rotate-90')} aria-hidden="true" />
          Note, group, optional
        </button>
        <Tools {...tools} />
      </div>
    </li>
  );
}

function StepEditor({ row, tools, errors, onChange }: { row: StepRow; tools: RowTools; errors?: { text?: string; timer?: string }; onChange(next: StepRow): void }) {
  const n = tools.index + 1;
  const timerId = useId();
  return (
    <li data-row-key={row.key} className="rounded-md border border-line bg-card-2/50 p-3">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="num mt-2 grid size-7 shrink-0 place-items-center rounded-full bg-sage-pale text-xs text-sage dark:text-sage-deep">{n}</span>
        <Textarea aria-label={`Step ${n}`} aria-invalid={errors?.text ? true : undefined} dir="auto" rows={2} maxLength={1000} placeholder="What to do in this step" className="field-sizing-content min-h-[4.5rem]" value={row.text} onChange={event => onChange({ ...row, text: event.target.value })} />
      </div>
      {errors?.text ? <p role="alert" className="mt-1.5 text-xs text-danger">{errors.text}</p> : null}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex items-center gap-2">
          <label htmlFor={timerId} className="text-xs text-ink-soft">Timer</label>
          <Input id={timerId} aria-invalid={errors?.timer ? true : undefined} aria-describedby={`${timerId}-help`} className="h-10 w-24 text-center" placeholder={row.timerTouched ? 'none' : 'auto'} inputMode="text" autoCapitalize="none" value={row.timer} onChange={event => onChange({ ...row, timer: event.target.value, timerTouched: true })} />
          <span id={`${timerId}-help`} className="sr-only">Minutes, minutes and seconds such as 1:30, or seconds such as 45s. Empty means no timer once you have changed it; untouched, a time in the step’s words sets it.</span>
        </div>
        <Tools {...tools} />
      </div>
      {errors?.timer ? <p role="alert" className="mt-1.5 text-xs text-danger">{errors.timer}</p> : null}
    </li>
  );
}

interface EditDialogProps {
  id: string;
  /** The recipe to edit, or null to write one from nothing. */
  recipe: Recipe | null;
  fallbackTitle: string;
  /** Called with nothing once the owner's version is stored. */
  onSaved(): void;
  /** Called after the dialog has left, so the parent can drop it. */
  onClosed(): void;
}

export function EditDialog({ id, recipe, fallbackTitle, onSaved, onClosed }: EditDialogProps) {
  const archive = useArchive();
  const [initial] = useState(() => formFromRecipe(recipe, fallbackTitle));
  const [form, setForm] = useState<RecipeForm>(initial);
  const [open, setOpen] = useState(true);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');
  const [errors, setErrors] = useState<FormErrors | null>(null);
  const [opener] = useState(() => rememberFocus());
  const body = useRef<HTMLDivElement>(null);
  const focusRow = useRef('');
  const dirty = formSignature(form) !== formSignature(initial);

  const close = () => {
    setOpen(false);
    setTimeout(onClosed, DIALOG_EXIT_MS);
  };
  const canClose = async () => {
    if (!dirty || saving) return !saving;
    return confirm({ title: 'Discard your changes to this recipe?', message: 'What you changed has not been saved yet.', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', danger: true });
  };

  const edit = (changes: Partial<RecipeForm>) => setForm(current => ({ ...current, ...changes }));
  const addRow = (kind: 'ingredients' | 'steps') => {
    const row = kind === 'ingredients' ? emptyIngredient() : emptyStep();
    focusRow.current = row.key;
    setForm(current => ({ ...current, [kind]: [...current[kind], row] }));
    // The new row exists after this render; put the keyboard in it.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      body.current?.querySelector<HTMLElement>(`[data-row-key="${focusRow.current}"] input, [data-row-key="${focusRow.current}"] textarea`)?.focus();
    }));
  };

  const submit = async () => {
    const built = buildEdit(form);
    if (!built.ok) {
      setErrors(built.errors);
      setProblem(built.errors.general ?? 'Some things need another look.');
      requestAnimationFrame(() => body.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setErrors(null);
    setProblem('');
    setSaving(true);
    try {
      await putRecipe(archive, id, built.body);
      toast('Your recipe is saved. It is kept beside the automatic reading.', { tone: 'saved' });
      onSaved();
      close();
    } catch (caught) {
      setProblem(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const tools = (kind: 'ingredients' | 'steps', index: number, noun: string): RowTools => ({
    index, count: form[kind].length, noun,
    onMove: direction => setForm(current => (kind === 'ingredients' ? { ...current, ingredients: moveRow(current.ingredients, index, direction) } : { ...current, steps: moveRow(current.steps, index, direction) })),
    onRemove: () => setForm(current => (kind === 'ingredients'
      ? { ...current, ingredients: current.ingredients.filter((_, position) => position !== index) }
      : { ...current, steps: current.steps.filter((_, position) => position !== index) })),
  });

  return (
    <Modal
      open={open}
      onClose={close}
      canClose={canClose}
      title={recipe ? 'Edit this recipe' : 'Write a recipe'}
      description="What you save here is yours. It is kept beside the automatic reading and is never overwritten by it."
      size="lg"
      opener={opener}
      initialFocus="content"
      testId="recipe-edit"
      footer={
        <>
          <span role="status" className={dirty ? 'label-mono me-auto max-sm:sr-only' : 'sr-only'}>{dirty ? '· unsaved changes' : ''}</span>
          <Button variant="outline" disabled={saving} onClick={() => void canClose().then(allowed => { if (allowed) close(); })}>Cancel</Button>
          <Button variant="primary" aria-busy={saving || undefined} disabled={saving} onClick={() => void submit()}><Check />{saving ? 'Saving…' : 'Save recipe'}</Button>
        </>
      }
    >
      <div ref={body} className="flex flex-col gap-6 pt-1">
        <FormError message={problem} />

        <section aria-label="Basics" className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" className="sm:col-span-2" help={problemText(errors?.title)}><Input value={form.title} dir="auto" maxLength={200} aria-invalid={errors?.title ? true : undefined} onChange={event => edit({ title: event.target.value })} /></Field>
          <Field label="Servings" help={problemText(errors?.servings) ?? 'Leave empty if it does not say.'}><Input value={form.servings} inputMode="decimal" aria-invalid={errors?.servings ? true : undefined} onChange={event => edit({ servings: event.target.value })} /></Field>
          <Field label="Total minutes" help={problemText(errors?.totalMinutes) ?? 'Optional.'}><Input value={form.totalMinutes} inputMode="decimal" aria-invalid={errors?.totalMinutes ? true : undefined} onChange={event => edit({ totalMinutes: event.target.value })} /></Field>
        </section>

        <section aria-labelledby="edit-ingredients">
          <h3 id="edit-ingredients" className="mb-3"><Whisper>ingredients</Whisper></h3>
          <datalist id="recipe-units">{UNITS.map(unit => <option key={unit} value={unit} />)}</datalist>
          <ul className="flex flex-col gap-2.5">
            {form.ingredients.map((row, index) => (
              <IngredientEditor key={row.key} row={row} errors={errors?.ingredients[row.key]} tools={tools('ingredients', index, 'ingredient')} onChange={next => setForm(current => ({ ...current, ingredients: current.ingredients.map(entry => (entry.key === row.key ? next : entry)) }))} />
            ))}
          </ul>
          <Button variant="soft" size="sm" className="mt-3" disabled={form.ingredients.length >= MAX_ROWS} onClick={() => addRow('ingredients')}><Plus />Add an ingredient</Button>
        </section>

        <section aria-labelledby="edit-steps">
          <h3 id="edit-steps" className="mb-1"><Whisper>method</Whisper></h3>
          <p className="mb-3 text-xs leading-relaxed text-ink-soft">A timer is set from the step’s own words (“10 minutes”) unless you set or clear it here. Which ingredients a step uses is worked out from their names.</p>
          <ol className="flex flex-col gap-2.5">
            {form.steps.map((row, index) => (
              <StepEditor key={row.key} row={row} errors={errors?.steps[row.key]} tools={tools('steps', index, 'step')} onChange={next => setForm(current => ({ ...current, steps: current.steps.map(entry => (entry.key === row.key ? next : entry)) }))} />
            ))}
          </ol>
          <Button variant="soft" size="sm" className="mt-3" disabled={form.steps.length >= MAX_ROWS} onClick={() => addRow('steps')}><Plus />Add a step</Button>
        </section>

        <section aria-labelledby="edit-notes">
          <h3 id="edit-notes" className="mb-3"><Whisper>notes</Whisper></h3>
          <Textarea aria-label="Notes" dir="auto" rows={3} maxLength={4000} placeholder="Anything worth remembering about this recipe…" value={form.notes} onChange={event => edit({ notes: event.target.value })} />
        </section>
      </div>
    </Modal>
  );
}
