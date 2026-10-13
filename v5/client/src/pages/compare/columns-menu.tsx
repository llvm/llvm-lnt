import {
  Button,
  Header,
  Menu,
  MenuItem,
  MenuSection,
  MenuTrigger,
  type Selection,
} from 'react-aria-components'
import { Popover } from '../../components/popover'
import { OPTIONAL_KEYS, optionalLabel, STATISTICS_OVER, type OptionalKey } from './columns'
import shared from '../../components/dropdown.module.css'
import styles from './compare.module.css'

interface Props {
  /** The optional columns shown. */
  shown: readonly OptionalKey[]
  onChange(shown: OptionalKey[]): void
}

/**
 * The Columns menu (CP2 "Optional columns"): a checkbox per optional statistic, which adds its
 * columns to the table, below a line saying what they are computed over. The menu stays open while
 * they are checked and unchecked.
 */
export function ColumnsMenu({ shown, onChange }: Props) {
  return (
    <MenuTrigger>
      <Button>
        Columns <span aria-hidden="true">▾</span>
      </Button>
      <Popover className={shared.popover} placement="bottom end">
        <Menu
          className={shared.list}
          selectionMode="multiple"
          selectedKeys={shown}
          shouldCloseOnSelect={false}
          onSelectionChange={(selection: Selection) =>
            onChange(OPTIONAL_KEYS.filter((key) => selection === 'all' || selection.has(key)))
          }
        >
          <MenuSection>
            <Header className={styles.menuNote}>{STATISTICS_OVER}</Header>
            {OPTIONAL_KEYS.map((key) => (
              <MenuItem key={key} id={key} textValue={optionalLabel(key)} className={shared.option}>
                {({ isSelected }) => (
                  <>
                    <span aria-hidden="true" className={styles.menuCheck}>
                      {isSelected ? '✓' : ''}
                    </span>
                    {optionalLabel(key)}
                  </>
                )}
              </MenuItem>
            ))}
          </MenuSection>
        </Menu>
      </Popover>
    </MenuTrigger>
  )
}
