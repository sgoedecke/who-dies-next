import { useContext, useState } from 'react';
import { resolveAbilityAsset, resolveItemAsset } from '../shared/assets';
import type { Hero } from '../shared/scenario';
import { AbilityArtwork, AssetContext, HeroPortrait, ItemArtwork } from './assets';
import { abilityStatus, cooldown, isAuxiliaryAbility, percent, readableAbilityName, readableName } from './game';

function ResourceBar({ kind, value, max }: { kind: 'hp' | 'mana'; value: number | null; max: number | null }) {
  const ratio = percent(value, max);
  const resource = kind === 'hp' ? 'HP' : 'Mana';
  const amount = `${value === null ? 'Unknown' : Math.round(value)} / ${max === null ? '?' : Math.round(max)}`;
  return <div className={`hud-resource ${kind} ${ratio === null ? 'unknown' : ''}`} aria-label={`${resource}: ${amount}`} title={`${resource}: ${amount}`}>
    <span className="hud-resource-fill" style={{ width: `${ratio ?? 0}%` }} />
    <span className="hud-resource-kind">{resource}</span><strong>{value === null ? '?' : Math.round(value)} / {max === null ? '?' : Math.round(max)}</strong>
  </div>;
}

function SlotOverlay({ seconds, unlearned = false }: { seconds: number | null; unlearned?: boolean }) {
  if (unlearned) return <span className="hud-slot-shade unlearned-shade" aria-hidden="true">—</span>;
  if (seconds === null) return <span className="hud-slot-shade unknown-shade" aria-hidden="true">?</span>;
  return seconds > 0 ? <span className="hud-slot-shade" aria-hidden="true">{seconds < 10 ? seconds.toFixed(1) : Math.ceil(seconds)}</span> : null;
}

export function HeroHUD({ hero }: { hero: Hero }) {
  const manifest = useContext(AssetContext);
  const abilities = hero.abilities.filter(ability => !isAuxiliaryAbility(ability.name));
  const bonuses = hero.abilities.filter(ability => isAuxiliaryAbility(ability.name));
  const [selected, setSelected] = useState<{ kind: 'ability' | 'item'; index: number }>({ kind: abilities.length ? 'ability' : 'item', index: 0 });
  const abilityName = (name: string) => resolveAbilityAsset(manifest, name)?.label ?? readableAbilityName(name, hero.id);
  const itemName = (name: string) => resolveItemAsset(manifest, name)?.label ?? readableName(name);
  const selectedAbility = selected.kind === 'ability' ? abilities[selected.index] : undefined;
  const selectedItem = selected.kind === 'item' ? hero.items[selected.index] : undefined;
  const seconds = (value: number | null) => value === null ? '?s' : `${value === 0 ? 0 : value.toFixed(1)}s`;

  return <div className="hero-hud">
    <div className="hud-topline">
      <div className="hud-portrait"><HeroPortrait hero={hero} large size={68} />
        <span className="hud-hero-level" aria-label={`Hero level ${hero.level ?? 'unknown'}`} title={`Observed hero level ${hero.level ?? 'unknown'}`}>{hero.level ?? '?'}</span>
      </div>
      <div className="hud-vitals">
        <div className="hud-identity"><h3>{hero.name}</h3><span className={hero.team}>{hero.team === 'radiant' ? 'Radiant' : 'Dire'}{hero.alive !== true && <span title={hero.alive === false ? 'Dead' : 'Alive state unknown'} aria-label={hero.alive === false ? 'Dead' : 'Alive state unknown'}> · {hero.alive === false ? '×' : '?'}</span>}</span></div>
        <ResourceBar kind="hp" value={hero.hp} max={hero.maxHp} />
        <ResourceBar kind="mana" value={hero.mana} max={hero.maxMana} />
      </div>
    </div>
    <div className="hud-controls">
      <section className="hud-abilities" aria-label="Observed abilities">
        <div className="hud-slot-grid">
          {abilities.map((ability, index) => {
            const label = abilityName(ability.name);
            const description = `${label}, level ${ability.level ?? 'unknown'}, ${abilityStatus(ability.level, ability.cooldown)}`;
            const active = selected.kind === 'ability' && selected.index === index;
            return <button type="button" className={`hud-slot ability-slot ${active ? 'active' : ''} ${ability.level === 0 ? 'unlearned' : ''} ${ability.level === null ? 'level-unknown' : ''}`}
              key={`${ability.name}:${index}`} aria-label={`Inspect ${description}`} title={description} aria-pressed={active}
              onClick={() => setSelected({ kind: 'ability', index })} onFocus={() => setSelected({ kind: 'ability', index })}>
              <AbilityArtwork name={ability.name} heroId={hero.id} />
              <SlotOverlay seconds={ability.cooldown} unlearned={ability.level === 0} />
              <span className="hud-slot-level" data-ability-level={ability.level ?? 'unknown'} aria-hidden="true">Lv {ability.level ?? '?'}</span>
            </button>;
          })}
        </div>
        {!abilities.length && <span className="unknown-affordance" title="Abilities not observed" aria-label="Abilities not observed">—</span>}
      </section>
      <section className="hud-inventory" aria-label="Observed inventory">
        <div className="hud-slot-grid">
          {hero.items.map((item, index) => {
            const label = itemName(item.name);
            const description = `${label}, ${cooldown(item.cooldown)}, ${item.charges === null ? 'charges unknown' : `${item.charges} charges`}`;
            const active = selected.kind === 'item' && selected.index === index;
            return <button type="button" className={`hud-slot item-slot ${active ? 'active' : ''}`} key={`${item.name}:${index}`}
              aria-label={`Inspect ${description}`} title={description} aria-pressed={active}
              onClick={() => setSelected({ kind: 'item', index })} onFocus={() => setSelected({ kind: 'item', index })}>
              <ItemArtwork name={item.name} slot />
              <SlotOverlay seconds={item.cooldown} />
              {item.charges !== null && item.charges > 0 && <span className="hud-slot-charges" aria-hidden="true">{item.charges}</span>}
            </button>;
          })}
        </div>
        {!hero.items.length && <span className="unknown-affordance" title="Items not observed" aria-label="Items not observed">—</span>}
      </section>
    </div>
    {(selectedAbility || selectedItem) && <div className="hud-observation" role="group" aria-label="Selected slot details">
      {selectedAbility ? <><strong>{abilityName(selectedAbility.name)}</strong><span title={`Level ${selectedAbility.level ?? 'unknown'} · ${abilityStatus(selectedAbility.level, selectedAbility.cooldown)}`}>
        Lv {selectedAbility.level ?? '?'} · {selectedAbility.level === 0 ? '—' : seconds(selectedAbility.cooldown)}
      </span></> : selectedItem && <><strong>{itemName(selectedItem.name)}</strong><span title={`${cooldown(selectedItem.cooldown)} · ${selectedItem.charges === null ? 'Charges unknown' : `${selectedItem.charges} charges`}`}>
        {seconds(selectedItem.cooldown)} · {selectedItem.charges ?? '?'}×
      </span></>}
    </div>}
    {bonuses.length > 0 && <details className="bonus-abilities hud-bonuses">
      <summary title="Observed talent and hidden ability entries">More ({bonuses.length})</summary>
      <ul>{bonuses.map((bonus, index) => <li key={index}><strong>{abilityName(bonus.name)}</strong><span title={`Level ${bonus.level ?? 'unknown'} · ${abilityStatus(bonus.level, bonus.cooldown)}`}>Lv {bonus.level ?? '?'} · {bonus.level === 0 ? '—' : seconds(bonus.cooldown)}</span></li>)}</ul>
    </details>}
  </div>;
}
